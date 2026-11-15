"""Внутренняя HTTP-служба ядра energybot: ответ на вопрос и всё, что видела при этом модель.

Публичный API стенда и виджета — Go-служба backend/: она принимает запросы фронта, хранит заявки, оценки
и журнал ответов в Postgres и ходит сюда за самим ответом. Здесь остаётся только то, что без ядра не
посчитать: ответ (та же логика, что у solution.py, в режиме «chat»), выдача поиска со скорами, состав
контекста, промпт, тайминги, срабатывания проверки ответа и сопоставление предложений с разделами базы.

Только стандартная библиотека, наружу служба не смотрит: на Railway — приватная сеть, локально — петля.

    set -a; source .env; set +a           # необязательно: служба сама читает .env из корня репозитория
    .venv/bin/python scripts/core_api.py  # → http://127.0.0.1:8788

Эндпоинты (при заданном EB_CORE_TOKEN — только с заголовком Authorization: Bearer <токен>):
    GET  /healthz               жива ли служба (без токена: это проба хостинга)
    GET  /core/health           схема ответа, есть ли модель, эмбеддинги, размер базы
    GET  /core/kb               база знаний разделами (те же фрагменты, что видит модель)
    POST /core/chat             {"messages": [{"role", "content"}], "mode": "chat"|"eval"|"copilot", "overrides": {…},
                                 "role": "grid"|…}
                                → SSE: stage, delta…, answer, done. overrides — настройки RAG только для этого ответа
                                (песочница стенда), те же ключи и пределы, что у /core/settings. role — роль-подсказка
                                собеседника (T15): одна строка в промпте, только в режиме chat; неизвестная — без неё.
                                delta {"text"} — кусок основного ответа модели по мере генерации (T13; не в eval,
                                EB_STREAM=0 или "stream": false в запросе — выключено). Проверка ответа работает
                                после генерации, поэтому главный текст — в answer: streamed — были ли дельты,
                                revised — финальный текст отличается от напечатанного (guard переписал или вырезал).
                                В answer — confidence (уверенность: поиск + опора, порог) и route:
                                answer | clarify (уточнение ниже порога, только chat при EB_CONFIDENCE_GATE=1),
                                honest_no — «честные нет» (T26, только chat): [{rule, product, reason, fact,
                                section, alternative}] по правилам из scripts/honest_no.py. Необязательный
                                "passport": {поле: значение} — паспорт задачи как ещё один источник фактов.
    GET  /core/settings         настройки RAG: текущие значения, значения из окружения, пределы
    POST /core/settings         {"values": {ключ: значение}} — поменять на лету для всех ответов (до перезапуска)
    POST /core/settings/reset   вернуть значения из окружения
"""

from __future__ import annotations

import hmac
import io
import json
import math
import os
import re
import socket
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def load_dotenv(path: Path) -> None:
    """Минимальный разбор .env: KEY=VALUE, уже заданные переменные окружения не перезаписываются."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip("'\""))


load_dotenv(ROOT / ".env")
# Стенд отвечает так же, как сабмит: вариант v28 — схема v3 с правилами «как у жюри» (eval/VARIANTS.md).
# Умолчание, а не жёсткая настройка: EB_STYLE из окружения по-прежнему главнее.
os.environ.setdefault("EB_STYLE", "jury")

import honest_no  # noqa: E402 — scripts/honest_no.py: «честные нет» (T26), только режим chat
import httpx  # noqa: E402 — зависимость energybot/llm.py
import index_cache  # noqa: E402 — scripts/index_cache.py, рядом с этим файлом

from energybot.dialog import search_queries  # noqa: E402
from energybot.guard import SENTENCE, numbers  # noqa: E402
from energybot.kb import KnowledgeBase  # noqa: E402
from energybot.llm import THINK, Api, DeadlineExceeded, env, env_num, strip_thinking  # noqa: E402
from energybot.pipeline import FALLBACK, Answer, Consultant, tidy  # noqa: E402
from energybot.prompts import CLARIFY_SYSTEM, ROLES, render_dialog  # noqa: E402
from energybot.text import tokens  # noqa: E402

MAX_BODY = 256_000
MAX_TURNS = 40


# ---------- журнал ----------
# Обращение, которое сейчас обрабатывает поток. Отдельно от Trace: Trace.reset() в начале ответа не должен
# стирать идентификатор, выданный ещё на входе запроса.
REQUEST = threading.local()
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def request_id() -> str:
    return getattr(REQUEST, "id", "")


def log(level: str, message: str, **fields) -> None:
    """Строка журнала: JSON при EB_LOG_FORMAT=json, иначе текст. request_id текущего потока — сам."""
    rid = request_id()
    if LOG_JSON:
        record = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "level": level,
                  "service": "core", "message": message}
        if rid:
            record["request_id"] = rid
        record.update(fields)
        line = json.dumps(record, ensure_ascii=False, default=str)
    else:
        extra = " ".join(f"{k}={v}" for k, v in fields.items())
        line = f"[core] {message}" + (f" {extra}" if extra else "") + (f" request_id={rid}" if rid else "")
    print(line, file=sys.stderr, flush=True)


class JsonStderr(io.TextIOBase):
    """stderr, где каждая строка — JSON с request_id текущего потока.

    energybot пишет свои строки ([llm], [retrieval], [consultant]) обычным print: правка их ради формата
    журнала задела бы код сабмита. Перехват на выходе даёт им тот же формат и request_id запроса, в котором
    они написаны, — так вызов модели находится в журнале по обращению из журнала Go-службы.
    """

    def __init__(self, raw):
        self.raw = raw
        self.local = threading.local()
        self.lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        buf = getattr(self.local, "buf", "") + text
        *lines, rest = buf.split("\n")
        self.local.buf = rest
        for line in lines:
            if line.strip():
                self._emit(line)
        return len(text)

    def _emit(self, line: str) -> None:
        if not line.startswith("{"):
            lowered = line.lower()
            level = "error" if ("traceback" in lowered or "error" in lowered or "ошибк" in lowered) else (
                "warn" if ("недоступ" in lowered or "отклонил" in lowered) else "info")
            record = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "level": level,
                      "service": "core", "message": line.strip()}
            if request_id():
                record["request_id"] = request_id()
            line = json.dumps(record, ensure_ascii=False)
        with self.lock:
            self.raw.write(line + "\n")
            self.raw.flush()

    def flush(self) -> None:
        self.raw.flush()


LOG_JSON = env("EB_LOG_FORMAT", "text") == "json"
if LOG_JSON:
    sys.stderr = JsonStderr(sys.stderr)


# ---------- отладочные данные одного ответа ----------
class Trace(threading.local):
    """Что видела модель при ответе в текущем потоке (сервер многопоточный, Consultant — общий).
    threading.local вызывает __init__ заново в каждом потоке, поэтому поля есть всегда."""

    def __init__(self):
        self.reset()

    def reset(self, emit=None):
        self.emit = emit
        self.ranked = []  # последняя выдача Retriever.search — до обрезки до top_k
        self.docs = []  # документы, отданные модели целиком (схема v3)
        self.chunks = []  # отдельные разделы контекста
        self.queries = {}
        self.calls = []  # все вызовы модели за ответ: промпт, ответ, время
        self.confidence = None  # retrieval-часть уверенности по последней выдаче (retrieval_confidence)
        self.prefetched = None  # выдача, найденная до ответа для порога уверенности (WebConsultant.prefetch)
        self.retrieval_ms = 0.0
        self.stream = False  # можно ли этому ответу слать delta (веб-режим, не eval)
        self.stream_on = False  # идёт основной вызов генерации — его и только его отдаём потоком
        self.streamed = ""  # текст, уже отправленный клиенту дельтами
        self.query_dense = False  # вектор вопроса получен: эмбеддинги в этом ответе работали


TRACE = Trace()


# ---------- переопределения настроек на один ответ (песочница стенда) ----------
# Consultant и Api — общие для всех потоков сервера, а настройки — их атрибуты. Песочница не может менять
# их на время ответа: соседний поток ответил бы с чужими настройками. Поэтому настраиваемые атрибуты —
# дескрипторы: в потоке, где действует overridden(), они отдают значения запроса, во всех остальных —
# общие. Внутри одного ответа ядро потоков не запускает, так что переопределение видно всему ответу.
OVERRIDES = threading.local()


class Overridable:
    """Атрибут экземпляра, который можно переопределить только для текущего потока."""

    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        values = getattr(OVERRIDES, "values", None)
        if values:
            key = (id(obj), self.name)
            if key in values:
                return values[key]
        try:
            return obj.__dict__[self.name]
        except KeyError:
            raise AttributeError(self.name) from None

    def __set__(self, obj, value):
        # Запись — всегда общее значение: глобальные настройки и сам код ядра пишут сюда, а не в запрос.
        obj.__dict__[self.name] = value


@contextmanager
def overridden(values: dict):
    """Внутри блока атрибуты из values ({(id(объекта), имя): значение}) переопределены для этого потока."""
    OVERRIDES.values = values
    try:
        yield
    finally:
        OVERRIDES.values = None


# ---------- потоковая выдача (T13) ----------
THINK_TAGS = ("<think>", "</think>")
TRANSIENT = (429, 500, 502, 503, 504)
FINAL = (400, 401, 403, 404, 422)


def thinking_requested(body: dict) -> bool:
    """Запрошены ли размышления в теле запроса (любым из параметров Api._thinking_fields)."""
    return bool((body.get("chat_template_kwargs") or {}).get("enable_thinking")
                or (body.get("reasoning") or {}).get("enabled") or body.get("enable_thinking"))


def visible_prefix(text: str, think: bool) -> str:
    """Часть ответа, которую уже можно показать клиенту, — по тем же правилам, что strip_thinking.

    Ответ — после последней </think>. С запрошенными размышлениями до неё не показываем ничего: vLLM без разбора
    размышлений шлёт их текстом без открывающей метки. Незакрытая <think> прячет всё после себя, а хвост,
    похожий на начало метки («<», «</th»), ждёт следующего куска."""
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    elif think:
        return ""
    text = THINK.sub("", text)
    if "<think>" in text:
        text = text.split("<think>")[0]
    cut = max((k for tag in THINK_TAGS for k in range(1, len(tag)) if text.endswith(tag[:k])), default=0)
    return (text[:-cut] if cut else text).lstrip()


class DeltaSink:
    """Шлёт клиенту прирост видимой части ответа событиями delta.

    Видимая часть только растёт; если она перестала начинаться с уже отправленного (размышление вдруг
    закрылось позже), поток замолкает — текст всё равно заменит финальное событие answer."""

    def __init__(self, think: bool):
        self.raw, self.think, self.sent, self.broken = "", think, "", False

    def feed(self, piece: str) -> None:
        self.raw += piece
        self.push(visible_prefix(self.raw, self.think))

    def close(self) -> None:
        self.push(strip_thinking(self.raw))

    def push(self, visible: str) -> None:
        if self.broken or not TRACE.emit:
            return
        if not visible.startswith(self.sent):
            self.broken = True
            return
        new = visible[len(self.sent):]
        if new:
            self.sent = visible
            TRACE.streamed += new
            TRACE.emit("delta", {"text": new})


class WebApi(Api):
    """Api стенда: параметры генерации и реранкер переопределяются на один ответ.

    Основной вызов генерации веб-ответа (TRACE.stream_on) идёт с "stream": true: куски ответа уходят клиенту
    событиями delta, а вызывающему возвращается тот же разобранный JSON, что и без потока, — вся обработка
    Api.chat (отказ от параметров, strip_thinking, повтор при исчерпанных размышлениях) не меняется.
    Сабмит (solution.py) и режим eval этот путь не видят: у них TRACE.stream_on не включается."""

    max_tokens = Overridable()
    temperature = Overridable()
    can_rerank = Overridable()

    def _post(self, url: str, key: str, body: dict, attempts: int = 3, timeout: float | None = None) -> dict:
        if not (TRACE.stream_on and TRACE.emit and url.endswith("/chat/completions")) or TRACE.streamed:
            return super()._post(url, key, body, attempts=attempts, timeout=timeout)
        last = None
        limit = timeout or self.timeout
        for attempt in range(attempts):
            remaining = self._remaining()
            if remaining is not None and remaining < 3:
                raise DeadlineExceeded("исчерпан общий лимит времени прогона")
            try:
                return self._stream(url, key, body, limit if remaining is None else min(limit, remaining - 1))
            except httpx.HTTPStatusError as exc:
                last = exc
                if exc.response is not None and exc.response.status_code in FINAL:
                    raise
            except (httpx.TimeoutException, httpx.TransportError, ValueError) as exc:
                last = exc
            if attempt + 1 >= attempts:
                break
            if TRACE.streamed:
                # Клиент уже видит часть текста: повтор — без потока, иначе текст напечатался бы дважды.
                return super()._post(url, key, body, attempts=attempts - attempt - 1, timeout=timeout)
            time.sleep(0.6 * (2 ** attempt))
        raise last

    def _stream(self, url: str, key: str, body: dict, timeout: float) -> dict:
        """Один потоковый запрос → {"choices": [{"message", "finish_reason"}], "usage"} как у обычного ответа."""
        started = time.perf_counter()
        sink = DeltaSink(thinking_requested(body))
        with self.client.stream("POST", url, headers={"Authorization": f"Bearer {key}"},
                                json={**body, "stream": True}, timeout=timeout) as r:
            if r.status_code >= 400:
                r.read()  # текст ошибки нужен Api.chat (context_overflow)
                raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
            if "text/event-stream" not in r.headers.get("content-type", ""):
                r.read()  # сервер не умеет потоки и ответил целиком — дельт нет, ответ тот же
                return r.json()
            content, reasoning, finish, usage = [], [], None, {}
            for line in r.iter_lines():
                # Тайм-аут httpx — на каждое чтение; общий предел ответа (размышления!) держим сами.
                if time.perf_counter() - started > timeout:
                    raise httpx.ReadTimeout("поток ответа дольше тайм-аута", request=r.request)
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                usage = chunk.get("usage") or usage
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    finish = choice.get("finish_reason") or finish
                    thought = delta.get("reasoning_content") or delta.get("reasoning")
                    if thought:
                        reasoning.append(thought)  # размышления отдельным полем клиенту не идут
                    if delta.get("content"):
                        content.append(delta["content"])
                        sink.feed(delta["content"])
        sink.close()
        message = {"role": "assistant", "content": "".join(content)}
        if reasoning:
            message["reasoning"] = "".join(reasoning)
        return {"choices": [{"message": message, "finish_reason": finish}], "usage": usage}


class WebConsultant(Consultant):
    """Тот же Consultant, что у solution.py, плюс запись выдачи поиска, контекста и вызовов модели.

    Перехват не зависит от версии ядра: выдача — из Retriever.search, промпт — из Api.chat, контекст — из
    результата retrieve (в одних версиях это (выдача, контекст), в других — (выдача, документы, фрагменты)).
    """

    # Всё, что меняет страница настроек: глобально — через Settings, на один ответ — через overridden().
    top_k = Overridable()
    n_candidates = Overridable()
    full_docs = Overridable()
    context_chars = Overridable()
    dense = Overridable()
    reference_text = Overridable()
    search = Overridable()
    style = Overridable()
    use_examples = Overridable()
    near = Overridable()
    think = Overridable()
    refine = Overridable()
    check_kb = Overridable()


    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        search, chat = self.retriever.search, self.api.chat

        def recording_search(*a, **kw):
            ranked = search(*a, **kw)
            TRACE.ranked = list(ranked)
            return ranked

        def recording_chat(messages, *a, **kw):
            if TRACE.emit and not TRACE.calls:
                TRACE.emit("stage", {"name": "generation"})
            t0 = time.perf_counter()
            output, error = "", ""
            try:
                output = chat(messages, *a, **kw)
                return output
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                raise
            finally:
                TRACE.calls.append({"messages": [dict(m) for m in messages], "output": output or "", "error": error,
                                    "ms": round((time.perf_counter() - t0) * 1000)})

        self.retriever.search = recording_search
        self.api.chat = recording_chat

    # Потоком идёт только основной вызов ответа: попытки generate / fm_generate до первого напечатанного куска.
    # Разбор вопроса (EB_PLAN) потоком не идёт — клиенту нужен только ответ после метки ОТВЕТ. Перезапросы
    # проверки, уточнение и вспомогательные вызовы (основа, опора, переписывание реплики) — тоже нет.
    def generate(self, messages: list, think: bool, attempts: int, plan: bool = False) -> tuple:
        with self._streaming(not plan):
            return super().generate(messages, think, attempts, plan)

    def fm_generate(self, messages: list) -> tuple:
        with self._streaming(True):
            return super().fm_generate(messages)

    @contextmanager
    def _streaming(self, allowed: bool):
        TRACE.stream_on = bool(allowed and TRACE.stream and not TRACE.streamed)
        try:
            yield
        finally:
            TRACE.stream_on = False

    def embed_queries(self, semantic_queries: list) -> list:
        vectors = super().embed_queries(semantic_queries)
        TRACE.query_dense = TRACE.query_dense or any(v is not None for v in vectors)
        return vectors

    def retrieve(self, turns, *args, **kwargs):
        cached = self._take_prefetched("retrieve", turns, args, kwargs)
        if cached is not None:
            return cached[0]
        result = super().retrieve(turns, *args, **kwargs)
        if len(result) == 3:  # (выдача, документы целиком, фрагменты)
            TRACE.docs, TRACE.chunks = list(result[1]), list(result[2])
        else:  # (лучшие фрагменты, контекст)
            TRACE.docs, TRACE.chunks = [], list(result[1])
        self._after_search(turns)
        return result

    def fm_search(self, turns, *args, **kwargs):  # схема factmap (есть не во всех версиях ядра)
        cached = self._take_prefetched("fm_search", turns, args, kwargs)
        if cached is not None:
            top, guard = cached
            if isinstance(kwargs.get("guard"), dict):
                kwargs["guard"].update(guard)
            return top
        top = super().fm_search(turns, *args, **kwargs)
        TRACE.docs, TRACE.chunks = [], list(top)
        self._after_search(turns)
        return top

    def _after_search(self, turns):
        lexical, semantic, last = search_queries(turns)
        TRACE.queries = {"lexical": lexical, "semantic": semantic, "last": last}
        TRACE.confidence = self.retrieval_confidence(turns)
        if TRACE.emit:
            TRACE.emit("stage", {"name": "retrieval", **self.retrieval_payload()})

    # ---------- уверенность и уточнение (T12) ----------
    def retrieval_confidence(self, turns) -> dict:
        """retrieval-часть уверенности по последней выдаче этого потока (TRACE.ranked)."""
        vocab = self.__dict__.setdefault("_vocab", {})  # основы слов раздела: считаются один раз на раздел

        def chunk_vocab(chunk) -> set:
            words = vocab.get(chunk.id)
            if words is None:
                words = vocab[chunk.id] = set(tokens(f"{chunk.path} {chunk.title} {chunk.text}"))
            return words

        return retrieval_confidence(turns, TRACE.ranked, self.retriever.bm25.idf, chunk_vocab)

    def prefetch(self, turns) -> dict | None:
        """Поиск до генерации — чтобы решить по порогу, отвечать ли вообще. Выдача запоминается, и answer()
        берёт её же, а не ищет заново: эмбеддинги и реранкер — платные вызовы. Возвращает retrieval-часть."""
        t0 = time.perf_counter()
        if self.arch == "factmap":
            guard = {}
            kind, value = "fm_search", (self.fm_search(turns, None, fast=False, guard=guard), guard)
        else:
            kind, value = "retrieve", (self.retrieve(turns),)
        TRACE.prefetched = (kind, [dict(t) for t in turns], value)
        TRACE.retrieval_ms = (time.perf_counter() - t0) * 1000
        return TRACE.confidence

    def _take_prefetched(self, kind: str, turns, args: tuple, kwargs: dict):
        """Выдача из prefetch, если ядро ищет то же самое: те же реплики, без вектора запроса и без «быстрого»
        режима (тот — другой поиск: без реранкера и с урезанным контекстом). Отдаётся один раз."""
        item = TRACE.prefetched
        if item is None or item[0] != kind or item[1] != turns:
            return None
        extra = list(args) + [v for k, v in kwargs.items() if k != "guard"]
        if any(v is not None and v is not False for v in extra):
            return None
        TRACE.prefetched = None
        return item[2]

    def clarify(self, turns) -> Answer:
        """Ответ ниже порога уверенности: честное «точного ответа нет» и один уточняющий вопрос.

        Вопрос пишет модель (CLARIFY_SYSTEM — без материалов базы, только диалог и названия ближайших тем);
        нет модели, сбой или ответ не по форме — вопрос по умолчанию. Фраза про специалиста — всегда без модели.
        """
        t0 = time.perf_counter()
        question, guard = "", {"route": "clarify"}
        if self.api.configured:
            topics = list(dict.fromkeys(h.chunk.title for h in TRACE.ranked[:CONFIDENCE_TOP]))[:3]
            try:
                question = clarify_question(self.api.chat(clarify_messages(turns, topics), max_tokens=160), turns)
            except Exception as exc:  # noqa: BLE001 — без модели остаётся вопрос по умолчанию
                guard["clarify_error"] = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] уточняющий вопрос: {guard['clarify_error']}", file=sys.stderr)
        if not question:
            guard["clarify_default"] = True
        generation = time.perf_counter() - t0
        timings = {"retrieval": TRACE.retrieval_ms / 1000, "generation": generation,
                   "total": TRACE.retrieval_ms / 1000 + generation}
        return Answer(f"{CLARIFY_LEAD} {question or CLARIFY_QUESTION}", [], timings, "", guard)

    # ---------- представление для фронтенда ----------
    @property
    def arch(self) -> str:
        return self.__dict__.get("arch", "v1")

    @arch.setter
    def arch(self, value):
        self.__dict__["arch"] = value

    def reference_chunks(self) -> list:
        """Справочник в неизменной части промпта (есть не во всех версиях ядра)."""
        if getattr(self, "reference_text", "") and hasattr(self.retriever, "reference"):
            return self.retriever.reference()
        return []

    def context_chunks(self) -> list:
        """Разделы, которые попали в промпт: документы целиком, отдельные фрагменты, справочник."""
        chunks = [c for c in self.kb.chunks if c.doc in TRACE.docs] + TRACE.chunks + self.reference_chunks()
        seen, out = set(), []
        for c in chunks:
            if c.id not in seen:
                seen.add(c.id)
                out.append(c)
        return out

    def retrieval_payload(self) -> dict:
        context = self.context_chunks()
        in_context = {c.id for c in context}
        hits = [{
            "rank": i + 1,
            "id": h.chunk.id,
            "doc": h.chunk.doc,
            "title": h.chunk.title,
            "path": h.chunk.path,
            "score": float(h.score) if h.score == h.score else None,
            "stage": h.stage,
            "in_context": h.chunk.id in in_context,
            "preview": h.chunk.text[:280],
        } for i, h in enumerate(TRACE.ranked[:30])]
        # Ступень поиска, по которой построена выдача (T30): видна в отладке. Реранкер и эмбеддинги, которых
        # ждали, но не получили, перечислены в skipped — ответ строится по более простой ступени.
        dense_used = bool(TRACE.query_dense and self.retriever.vectors is not None)
        reranked = bool(TRACE.ranked) and TRACE.ranked[0].stage == "rerank"
        skipped = []
        if self.api.configured:
            if self.api.use_embeddings and (self.retriever.vectors is None or (self.dense and not dense_used)):
                skipped.append("embeddings")
            if self.api.can_rerank and not reranked:
                skipped.append("reranker")
        tier = "bm25" + (" + эмбеддинги" if dense_used else "") + (" + реранкер" if reranked else "")
        return {
            "arch": self.arch,
            "dense": self.dense,
            "tier": tier,
            "skipped": skipped,
            "queries": TRACE.queries,
            "hits": hits,
            "context": {
                "full_docs": list(TRACE.docs),
                "chunk_ids": [c.id for c in context],
                "chars": sum(len(c.render()) for c in context),
            },
        }


def content_tokens(text: str) -> set:
    return {t for t in tokens(text) if len(t) >= 3 and not t.isdigit()}


def attribute(answer: str, chunks: list) -> list:
    """Сопоставляет каждое предложение ответа с разделами контекста, на которые оно опирается.

    Это эвристика для отладки (пересечение основ слов + совпадение чисел), а не объяснение модели:
    модель не размечает источники сама, потому что ответ по регламенту — одна строка без разметки.
    """
    prepared = [(c, content_tokens(c.search_text()), numbers(c.text)) for c in chunks]
    result = []
    for sentence in SENTENCE.split(answer.strip()):
        words = content_tokens(sentence)
        nums = {n for n in numbers(sentence) if not (n.isdigit() and int(n) <= 2)}
        scored = []
        for chunk, vocab, chunk_nums in prepared:
            if not words:
                break
            overlap = len(words & vocab) / len(words)
            matched = sorted(nums & chunk_nums)
            score = overlap + 0.25 * len(matched)
            if overlap >= 0.3 or matched:
                scored.append((score, overlap, matched, chunk))
        scored.sort(key=lambda x: -x[0])
        support = [{
            "id": c.id, "doc": c.doc, "path": c.path, "overlap": round(o, 2), "numbers": m,
        } for _, o, m, c in scored[:2]]
        result.append({
            "sentence": sentence,
            "question": sentence.rstrip().endswith("?"),
            "support": support,
            "unsupported_numbers": sorted(n for n in nums if not any(n in s["numbers"] for s in support)),
        })
    return result


# ---------- уверенность ответа (T12) ----------
# Две части. retrieval — до генерации, по выдаче поиска: доля слов вопроса (с весом idf BM25), которые есть в
# лучшем из первых CONFIDENCE_TOP разделов выдачи; если выдачу упорядочил реранкер — среднее с его оценкой
# лучшего раздела. support — после генерации, по опоре (attribute): доля утверждений ответа, у которых нашёлся
# раздел и нет чисел без опоры. Итог — среднее частей (только retrieval, если опору считать не по чему).
# Порог сравнивается с retrieval: решение «уточнить вместо ответа» принимается до вызова модели.
#
# Порог по умолчанию — осторожный из eval/confidence_calibration.py на dev, офлайн (BM25, без эмбеддингов и
# реранкера — это платные API): в уточнение уходит не больше 5 % вопросов, ответ на которые в базе есть.
# Различение слабое (ROC AUC ≈ 0,64; максимум F1 ≈ 0,29 при пороге 0,28 и отказе на трети хороших вопросов),
# поэтому гейт выключен по умолчанию (EB_CONFIDENCE_GATE=0). С реранкером шкала retrieval другая — порог
# калибруется заново.
CONFIDENCE_TOP = 5
CONFIDENCE_THRESHOLD = 0.16

CLARIFY_LEAD = ("В моих материалах нет точного ответа на этот вопрос, поэтому не буду гадать — "
                "уточню его у специалиста МТС EnergyTool.")
CLARIFY_QUESTION = "Чтобы передать вопрос точнее, расскажите, пожалуйста, что у вас за объект и какую задачу хотите решить?"


def question_terms(turns: list) -> set:
    """Основы слов последней реплики клиента; короткое «да» или «а сколько?» — по всем его репликам.
    Числа не в счёт: «200 счётчиков» — подробность клиента, а не тема, которой нет в базе."""
    def words(text: str) -> set:
        return {t for t in tokens(text) if not t[0].isdigit()}

    users = [t["content"] for t in turns if t.get("role") == "user"]
    terms = words(users[-1]) if users else set()
    return terms or words(" ".join(users))


def retrieval_confidence(turns: list, ranked: list, idf: dict, vocab) -> dict:
    """retrieval-часть уверенности: 0..1 и из чего сложилась. vocab(chunk) → множество основ слов раздела.

    Слова, которых нет во всей базе, весят как самые редкие слова базы: «ветряк», «WhatsApp», «Новосибирск»
    в вопросе — признак того, что ответа в материалах может не быть.
    """
    terms = question_terms(turns)
    rare = max(idf.values(), default=1.0)
    weights = {t: idf.get(t, rare) for t in terms}
    total = sum(weights.values())
    top = list(ranked[:CONFIDENCE_TOP])
    lexical, best = 0.0, None
    for h in top:
        covered = sum(w for t, w in weights.items() if t in vocab(h.chunk)) / total if total else 0.0
        if best is None or covered > lexical:
            lexical, best = covered, h
    found = vocab(best.chunk) if best else set()
    missing = sorted((t for t in terms if t not in found), key=lambda t: -weights[t])[:6]
    detail = f"в разделе «{best.chunk.path}»" if best else "выдача пуста"
    if missing:
        detail += f"; нет основ: {', '.join(missing)}"
    parts = [{"key": "lexical", "label": "Слова вопроса в лучшем разделе", "value": round(lexical, 3),
              "detail": detail}]
    stage = top[0].stage if top else "none"
    score = lexical
    if stage == "rerank":
        raw = float(top[0].score)
        rerank = min(1.0, max(0.0, raw)) if math.isfinite(raw) else 0.0
        parts.append({"key": "rerank", "label": "Оценка реранкера", "value": round(rerank, 3),
                      "detail": f"лучший раздел «{top[0].chunk.path}»"})
        score = (lexical + rerank) / 2
    return {"score": round(score, 3), "stage": stage, "parts": parts}


def support_confidence(citations: list) -> dict | None:
    """support-часть: доля утверждений (не вопросов клиенту) с опорой и без чисел вне базы."""
    claims = [c for c in citations if not c["question"]]
    if not claims:
        return None
    grounded = sum(1 for c in claims if c["support"] and not c["unsupported_numbers"])
    return {"score": round(grounded / len(claims), 3), "grounded": grounded, "claims": len(claims)}


def answer_confidence(retrieval: dict, support: dict | None, threshold: float, gate: bool, gated: bool) -> dict:
    """Поле confidence события answer: итог 0..1, части, порог и сработал ли он."""
    r = retrieval["score"]
    s = support["score"] if support else None
    score = r if s is None else (r + s) / 2
    parts = [dict(p, part="retrieval") for p in retrieval["parts"]]
    if support:
        parts.append({"key": "support", "part": "support", "label": "Утверждения с опорой в базе", "value": s,
                      "detail": f"{support['grounded']} из {support['claims']}"})
    how = f"поиск {r:.2f}" + (f" и опора {s:.2f} поровну" if s is not None else "; опору считать не по чему")
    rule = (f"поиск ниже порога {threshold:.2f} — вместо ответа уточняющий вопрос" if gated else
            f"порог {threshold:.2f} проверяется по поиску до генерации" if gate else
            "порог не применяется (только чат при EB_CONFIDENCE_GATE=1)")
    return {"score": round(score, 3), "threshold": threshold, "retrieval": r, "support": s,
            "stage": retrieval["stage"], "parts": parts, "gate": gate, "gated": gated,
            "explain": f"Итог {score:.2f}: {how}; {rule}."}


def clarify_messages(turns: list, topics: list) -> list:
    near = f"\n\nБлижайшие темы базы знаний (могут не подходить): {'; '.join(topics)}" if topics else ""
    return [{"role": "system", "content": CLARIFY_SYSTEM},
            {"role": "user", "content": f"{render_dialog(turns)}{near}\n\nЗадай один уточняющий вопрос клиенту."}]


def clarify_question(raw: str, turns: list) -> str:
    """Первый вопрос из ответа модели; пусто, если вопроса нет, он длинный или в нём числа не из диалога."""
    said = numbers(" ".join(t["content"] for t in turns))
    for sentence in SENTENCE.split(tidy(raw or "")):
        sentence = sentence.strip()
        if sentence.endswith("?"):
            if len(sentence) > 300 or numbers(sentence) - said:
                return ""
            return sentence
    return ""


# ---------- настройки RAG на лету ----------
# Глобальные: «Сохранить» на странице настроек стенда (только с админ-токеном, его проверяет Go-API) меняет
# поведение консультанта для всех, кто с ним говорит, до перезапуска ядра. Значения из окружения запоминаются
# при старте, «Сбросить к окружению» возвращает их. Все поля читаются консультантом в момент ответа, поэтому
# смена действует со следующего вопроса; идущий ответ досчитывается со старыми значениями там, где он их уже прочёл.
#
# Песочница: те же ключи с теми же пределами приходят полем overrides запроса /core/chat и действуют только
# на этот ответ (overridden() выше). Так жюри может пробовать настройки, не меняя бота другим посетителям.
class Field:
    def __init__(self, key, group, kind, env_name, obj, name, lo=None, hi=None, options=None, available=None,
                 to_attr=None, from_attr=None, sandbox_hi=None):
        self.key, self.group, self.kind, self.env = key, group, kind, env_name
        self.obj, self.name, self.lo, self.hi, self.options = obj, name, lo, hi, options
        # Потолок песочницы: анонимный посетитель не должен раздувать цену ответа (контекст, токены)
        # до предела, доступного администратору. Общее значение выше потолка песочница не урезает.
        self.sandbox_hi = sandbox_hi
        self.available = available or (lambda: True)
        # Значение настройки и значение атрибута не всегда совпадают: справочник включается его текстом,
        # эмбеддинги — только при построенных векторах.
        self.to_attr = to_attr or (lambda v: v)
        self.from_attr = from_attr or (lambda v: v)

    def get(self):
        return self.from_attr(getattr(self.obj, self.name))

    def set(self, value) -> None:
        setattr(self.obj, self.name, self.to_attr(value))

    def override(self, value) -> tuple:
        """Ключ и значение для overridden(): атрибут этого поля только в текущем ответе."""
        return (id(self.obj), self.name), self.to_attr(value)

    def coerce_sandbox(self, value):
        number = self.coerce(value)
        if self.sandbox_hi is not None:
            cap = max(self.sandbox_hi, self.get())
            if number > cap:
                raise ValueError(f"{self.key}: в песочнице — не больше {cap}")
        return number

    def coerce(self, value):
        if self.kind == "bool":
            if isinstance(value, bool):
                return value
            raise ValueError(f"{self.key}: ожидается да/нет")
        if self.kind == "enum":
            if value in self.options:
                return value
            raise ValueError(f"{self.key}: допустимо {', '.join(map(str, self.options))}")
        try:
            number = float(value) if self.kind == "float" else int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{self.key}: ожидается число") from None
        if isinstance(value, bool) or not (self.lo <= number <= self.hi):
            raise ValueError(f"{self.key}: от {self.lo} до {self.hi}")
        return number

    def meta(self) -> dict:
        out = {"key": self.key, "group": self.group, "kind": self.kind, "env": self.env, "available": self.available()}
        if self.kind in ("int", "float"):
            out |= {"min": self.lo, "max": self.hi}
            if self.sandbox_hi is not None:
                out["sandbox_max"] = max(self.sandbox_hi, self.get())
        if self.kind == "enum":
            out["options"] = self.options
        return out


class Settings:
    def __init__(self, bot: Consultant, api: Api):
        reference = bot.reference_text  # справочник выключается пустой строкой, а включается обратно им же
        # Векторы могут появиться и после старта (App.retry_dense), поэтому — проверка в момент обращения,
        # а не снимок на старте.
        def has_vectors() -> bool:
            return bot.retriever.vectors is not None

        self.fields = [
            Field("top_k", "search", "int", "EB_TOP_K", bot, "top_k", lo=0, hi=30),
            Field("n_candidates", "search", "int", "EB_N_CANDIDATES", bot, "n_candidates", lo=5, hi=80, sandbox_hi=40),
            Field("full_docs", "search", "int", "EB_FULL_DOCS", bot, "full_docs", lo=0, hi=6, sandbox_hi=3),
            Field("context_chars", "search", "int", "EB_CONTEXT_CHARS", bot, "context_chars", lo=2000, hi=200000,
                  sandbox_hi=60000),
            Field("use_dense", "search", "bool", "EB_USE_EMBEDDINGS", bot, "dense",
                  to_attr=lambda v: bool(v) and has_vectors(), available=has_vectors),
            Field("use_reranker", "search", "bool", "EB_USE_RERANKER", api, "can_rerank",
                  available=lambda: api.configured),
            Field("use_reference", "search", "bool", "EB_REFERENCE", bot, "reference_text",
                  to_attr=lambda v: reference if v else "", from_attr=bool, available=lambda: bool(reference)),
            Field("search", "search", "enum", "EB_SEARCH", bot, "search",
                  options=list(dict.fromkeys(["v3", "ve", bot.search]))),
            # Стили правил из energybot/prompts.py; значение из окружения добавляется, даже если оно своё.
            Field("style", "generation", "enum", "EB_STYLE", bot, "style",
                  options=list(dict.fromkeys(["tight", "full", "recipe", "jury", "jury2", bot.style]))),
            Field("use_examples", "generation", "bool", "EB_EXAMPLES", bot, "use_examples"),
            Field("near", "generation", "int", "EB_NEAR", bot, "near", lo=0, hi=8, sandbox_hi=4),
            Field("temperature", "generation", "float", "EB_TEMPERATURE", api, "temperature", lo=0.0, hi=2.0),
            Field("max_tokens", "generation", "int", "EB_MAX_TOKENS", api, "max_tokens", lo=128, hi=8192,
                  sandbox_hi=2048),
            Field("think", "generation", "bool", "EB_THINK", bot, "think"),
            Field("refine", "generation", "bool", "EB_REFINE", bot, "refine"),
            Field("check_kb", "generation", "enum", "EB_CHECK", bot, "check_kb", options=[0, 1, 2]),
        ]
        self.by_key = {f.key: f for f in self.fields}
        self.defaults = self.values()
        self.lock = threading.Lock()
        self.updated_at = None

    def values(self) -> dict:
        return {f.key: f.get() for f in self.fields}

    def snapshot(self, model: str) -> dict:
        values = self.values()
        return {
            "fields": [f.meta() for f in self.fields],
            "values": values,
            "defaults": self.defaults,
            "changed": [k for k, v in values.items() if v != self.defaults[k]],
            "model": model,
            "updated_at": self.updated_at,
        }

    def validate(self, values, name: str = "values", sandbox: bool = False) -> dict:
        """Ключи и пределы — одни для глобальных настроек и для песочницы; у песочницы ниже потолок
        у полей, от которых растёт цена ответа. Ошибка — ValueError с текстом для человека."""
        if not isinstance(values, dict):
            raise ValueError(f"{name}: ожидается объект {{ключ: значение}}")
        unknown = sorted(set(values) - set(self.by_key))
        if unknown:
            raise ValueError(f"неизвестные настройки: {', '.join(unknown)}")
        return {k: (self.by_key[k].coerce_sandbox(v) if sandbox else self.by_key[k].coerce(v)) for k, v in values.items()}

    def update(self, values) -> None:
        clean = self.validate(values)  # сначала проверить всё, потом менять
        with self.lock:
            for k, v in clean.items():
                self.by_key[k].set(v)
            self.updated_at = time.time()
        print(f"[core] настройки: {clean}", file=sys.stderr)

    def overrides(self, values) -> tuple:
        """Переопределения песочницы: (проверенные значения, аргумент для overridden()). Пусто — ({}, {})."""
        if values is None:
            return {}, {}
        clean = self.validate(values, "overrides", sandbox=True)
        return clean, dict(self.by_key[k].override(v) for k, v in clean.items())

    def reset(self) -> None:
        # Значения из окружения ставятся как есть, без проверки пределов: их уже приняло ядро при старте.
        with self.lock:
            for k, v in self.defaults.items():
                self.by_key[k].set(v)
            self.updated_at = None
        print("[core] настройки: сброшены к окружению", file=sys.stderr)


# ---------- приложение ----------
class App:
    def __init__(self, api: WebApi | None = None):
        kb_path = Path(env("EB_KB_PATH", str(ROOT / "knowledge-base")))
        self.api = api or WebApi()
        t0 = time.perf_counter()
        index_dir, from_cache = self.index_dir(kb_path)
        self.bot = WebConsultant(kb_path, index_dir=index_dir, api=self.api)
        saved = index_dir is not None and env("EB_INDEX_CACHE_DIR") != "" and \
            index_cache.save(self.bot.retriever, index_dir)
        log("info", "индекс готов", dense=self.bot.dense, from_cache=from_cache, saved=bool(saved),
            took_ms=round((time.perf_counter() - t0) * 1000), cache=str(index_dir or ""))
        self.mode = env("EB_WEB_MODE", "chat")
        # Порог уверенности (T12): ниже него — уточняющий вопрос вместо ответа. Только режим chat и только под
        # флагом; автопроверка (eval) и копилот отвечают как раньше при любых значениях.
        self.gate = env("EB_CONFIDENCE_GATE", "0") == "1"
        self.threshold = env_num("EB_CONFIDENCE_THRESHOLD", CONFIDENCE_THRESHOLD, 0.0, 1.0, float)
        # Потоковая выдача (T13): delta по мере генерации. Выключатель на случай сервера модели, который
        # плохо держит "stream": true; режим eval не стримит никогда.
        self.stream = env("EB_STREAM", "1") != "0"
        self.settings = Settings(self.bot, self.api)
        self.kb_path = kb_path
        # «Честные нет» (T26): правила привязываются к разделам базы один раз; правило без опоры выключается.
        self.honest = honest_no.Detector(self.bot.kb)
        if self.honest.disabled:
            log("warn", "правила «честных нет» без опоры в базе выключены", rules=",".join(self.honest.disabled))
        if self.wants_dense() and not self.bot.dense:
            threading.Thread(target=self.retry_dense, name="dense-retry", daemon=True).start()

    def wants_dense(self) -> bool:
        # Режим крошек есть не во всех версиях Retriever; без него векторы всегда «по умолчанию».
        crumbs = getattr(self.bot.retriever, "crumbs", "path")
        return self.api.configured and self.api.use_embeddings and crumbs == "path"

    def retry_dense(self, every: float | None = None) -> None:
        """Достраивает векторы, если на старте модель эмбеддингов не ответила.

        Ядро стартует и без них — на BM25, — но без этой попытки так и осталось бы до перезапуска: на хостинге
        порядок старта служб не гарантирован, и шлюз к моделям может подняться позже ядра. Векторы
        подменяются целиком одним присваиванием: поиск в других потоках видит либо старое, либо новое.
        """
        every = every if every is not None else env_num("EB_DENSE_RETRY_SEC", 30.0, 5.0, 3600.0, float)
        attempt = 0
        # Условие — векторы, а не флаг dense: флаг может выключить оператор в настройках RAG, и тогда
        # достраивать нечего — векторы уже есть.
        while self.bot.retriever.vectors is None:
            time.sleep(every)
            attempt += 1
            index_dir, _ = self.index_dir(self.kb_path)
            if env("EB_INDEX_CACHE_DIR") and index_dir is None:
                continue  # модель ещё не отвечает даже на контрольную фразу
            vectors = self.bot.retriever._load_or_build_vectors(index_dir)
            if vectors is None:
                continue
            self.bot.retriever.vectors = vectors
            self.bot.dense = True
            if env("EB_INDEX_CACHE_DIR") and index_dir is not None:
                index_cache.save(self.bot.retriever, index_dir)
            log("info", "векторы построены после старта", attempt=attempt)

    def index_dir(self, kb_path: Path) -> tuple:
        """Каталог векторов: кеш по текстам и модели (EB_INDEX_CACHE_DIR) или ROOT/index, как у сабмита."""
        root = env("EB_INDEX_CACHE_DIR")
        if not root:
            return ROOT / "index", False
        if not (self.api.configured and self.api.use_embeddings):
            return None, False
        target = index_cache.index_dir(Path(root), KnowledgeBase.load(kb_path), self.api)
        return target, index_cache.cached(target)

    def health(self) -> dict:
        docs = dict.fromkeys(c.doc for c in self.bot.kb.chunks)
        return {
            "ok": True,
            "arch": self.bot.arch,
            "llm": self.api.configured,
            "model": env("LLM_MODEL", ""),
            "dense": self.bot.dense,
            "reranker": bool(self.api.configured and self.api.can_rerank),
            "chunks": len(self.bot.kb.chunks),
            "docs": len(docs),
            "kb_fingerprint": self.bot.kb.fingerprint,
            "mode": self.mode,
            "confidence_gate": self.gate,
            "confidence_threshold": self.threshold,
        }

    def kb(self) -> dict:
        reference = {c.id for c in self.bot.reference_chunks()}
        docs = {}
        for i, c in enumerate(self.bot.kb.chunks):
            entry = docs.setdefault(c.doc, {"doc": c.doc, "title": c.title, "group": c.doc.split("/")[0], "chunks": []})
            entry["chunks"].append({
                "id": c.id, "order": i, "path": c.path, "text": c.text, "links": c.links,
                "is_guard": c.is_guard, "is_reference": c.id in reference,
            })
        return {"fingerprint": self.bot.kb.fingerprint, "docs": list(docs.values())}

    def chat(self, body: dict, emit) -> dict:
        turns = clean_turns(body.get("messages"))
        mode = body.get("mode") if body.get("mode") in ("chat", "eval", "copilot") else self.mode
        applied, values = self.settings.overrides(body.get("overrides"))
        # Роль (T15) — только подсказка промпту чата. Список ролей проверяет шлюз; здесь неизвестная или чужому
        # режиму — просто без подсказки: ответ не должен ломаться из-за расхождения списков.
        role = body.get("role") if isinstance(body.get("role"), str) else ""
        role = role if mode == "chat" and role in ROLES else ""
        # Весь ответ — и поиск, и представление для отладки — с настройками этого запроса.
        stream = self.stream and mode != "eval" and body.get("stream") is not False
        with overridden(values):
            payload = self._chat(turns, mode, emit, body.get("passport"), stream, role)
        payload["overrides"] = applied
        return payload

    def _chat(self, turns: list, mode: str, emit, passport=None, stream: bool = False, role: str = "") -> dict:
        TRACE.reset(emit)
        TRACE.stream = bool(stream and emit)
        t0 = time.perf_counter()
        # Порог решается по поиску до генерации и только в чате: в eval и copilot путь ответа прежний.
        gate = self.gate and mode == "chat"
        gated = False
        if gate:
            retrieval = self.bot.prefetch(turns)
            gated = retrieval is not None and retrieval["score"] < self.threshold
        answer = self.bot.clarify(turns) if gated else self.bot.answer(turns, mode=mode, role=role)
        total = (time.perf_counter() - t0) * 1000
        # Модель недоступна (T30): только в чате с клиентом. Автопроверка (eval) и копилот остаются при прежнем
        # FALLBACK — судья сравнивает с эталонами, а копилот обращается к менеджеру, не к клиенту.
        degraded = None
        if mode == "chat" and not gated and (answer.text == FALLBACK or answer.error):
            reason = self.model_down_reason()
            if reason:
                degraded = {"reason": reason, "sections": degraded_sections(TRACE.ranked)}
                answer.text = DEGRADED_TEXT
                answer.guard = {**answer.guard, "degraded": reason}
        chunks = self.bot.context_chunks()
        by_id = {c.id: c for c in self.bot.kb.chunks}
        sources = []
        for doc in TRACE.docs:
            first = next((c for c in self.bot.kb.chunks if c.doc == doc), None)
            sources.append({"kind": "doc", "doc": doc, "title": first.title if first else doc,
                            "chunk_id": first.id if first else None})
        for c in TRACE.chunks:
            sources.append({"kind": "chunk", "doc": c.doc, "title": c.title, "path": c.path, "chunk_id": c.id})
        # Основной промпт — первый вызов модели за ответ; следующие (перезапрос проверки чисел и т. п.)
        # показываются кратко: время, последняя реплика-указание и что ответила модель.
        prompt = [{"role": m["role"], "content": str(m["content"])} for m in TRACE.calls[0]["messages"]] \
            if TRACE.calls else []
        calls = [{
            "ms": c["ms"],
            "prompt_chars": sum(len(str(m["content"])) for m in c["messages"]),
            "instruction": str(c["messages"][-1]["content"])[-1500:] if i else "",
            "output": c["output"][:3000],
            "error": c["error"],
        } for i, c in enumerate(TRACE.calls)]
        timings = {k: round(v * 1000) for k, v in answer.timings.items()}
        if TRACE.retrieval_ms and not gated:  # поиск был в prefetch, answer() взял готовую выдачу
            timings["retrieval"] = max(timings.get("retrieval", 0), round(TRACE.retrieval_ms))
        payload = {
            "id": uuid.uuid4().hex,
            "route": "clarify" if gated else "answer",
            "text": answer.text,
            "fallback": answer.text == FALLBACK or bool(answer.error),
            "error": answer.error,
            "mode": mode,
            "role": role,
            "timings": timings | {"server_total": round(total)},
            "guard": answer.guard,
            "trace": getattr(answer, "trace", ""),
            "sources": sources,
            "citations": attribute(answer.text, chunks),
            "retrieval": self.bot.retrieval_payload() if TRACE.ranked or TRACE.chunks else None,
            "prompt": prompt,
            "prompt_chars": sum(len(m["content"]) for m in prompt),
            "llm_calls": calls,
            "model": env("LLM_MODEL", ""),
            # Финальный текст главнее дельт: guard работает после генерации и может переписать или вырезать
            # напечатанное. Сравнение — после той же чистки (tidy), что прошёл ответ.
            "streamed": bool(TRACE.streamed),
            "revised": bool(TRACE.streamed) and tidy(TRACE.streamed) != answer.text,
        }
        # Подписи к источникам: путь раздела для чипов в ответе.
        for cite in payload["citations"]:
            for s in cite["support"]:
                s["title"] = by_id[s["id"]].title if s["id"] in by_id else s["doc"]
        # Опору у запасного ответа и у уточнения не считаем: там нет утверждений по существу.
        support = None if gated or payload["fallback"] else support_confidence(payload["citations"])
        retrieval = TRACE.confidence or self.bot.retrieval_confidence(turns)
        payload["confidence"] = answer_confidence(retrieval, support, self.threshold, gate, gated)
        # «Честные нет» (T26): детерминированно по репликам клиента, только чат; автопроверка и копилот — пусто.
        payload["honest_no"] = self.honest.detect(turns, passport) if mode == "chat" else []
        if degraded:
            payload["degraded"] = degraded
        return payload

    def model_down_reason(self) -> str:
        """Почему нет ответа модели: ключа нет вовсе или ни один вызов за ответ не вернул текст. Ответ,
        отброшенный проверкой, или пустой ответ живой модели — не сбой, там своя запасная фраза."""
        if not self.api.configured:
            return "model_unconfigured"
        if TRACE.calls and not any(c["output"] for c in TRACE.calls) and all(c["error"] for c in TRACE.calls):
            return "model_error"
        return ""


DEGRADED_TEXT = "Сейчас не могу сформулировать ответ, вот что есть в материалах."
DEGRADED_SECTIONS = 3
DEGRADED_EXCERPT = 360


def excerpt(text: str, limit: int = DEGRADED_EXCERPT) -> str:
    """Начало раздела для показа клиенту: по границе слова, одной строкой."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:—-")
    return cut + "…"


def degraded_sections(ranked: list, limit: int = DEGRADED_SECTIONS) -> list:
    """2–3 самых релевантных раздела выдачи — поиск работает и без модели (BM25 / эмбеддинги / реранкер).
    Служебные разделы-ограничения (is_guard) клиенту не показываем: это правила для модели."""
    out, seen = [], set()
    for hit in ranked:
        chunk = hit.chunk
        if chunk.id in seen or chunk.is_guard or not chunk.text.strip():
            continue
        seen.add(chunk.id)
        out.append({"chunk_id": chunk.id, "doc": chunk.doc, "title": chunk.title, "path": chunk.path,
                    "excerpt": excerpt(chunk.text)})
        if len(out) >= limit:
            break
    return out


def clean_turns(messages, require_user: bool = True) -> list:
    """Те же правила, что у Go-службы (internal/dialog): ядро не доверяет даже своему шлюзу."""
    if not isinstance(messages, list):
        raise ValueError("messages: ожидается список реплик")
    turns = []
    for m in messages[-MAX_TURNS:]:
        if not isinstance(m, dict):
            continue
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = " ".join(str(m.get("content", "")).split())[:4000]
        if content:
            turns.append({"role": role, "content": content})
    if require_user and (not turns or turns[-1]["role"] != "user"):
        raise ValueError("последняя реплика должна быть от пользователя")
    return turns


def make_handler(app: App):
    # Ядро тратит деньги на модель, поэтому даже в приватной сети отвечает только своему шлюзу.
    token = env("EB_CORE_TOKEN")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: A003 — короче стандартного лога
            if self.path != "/healthz":  # пробы хостинга раз в несколько секунд заслоняют настоящие запросы
                log("info", "запрос", method=self.command, path=self.path,
                    status=args[1] if len(args) > 1 else "")

        def begin(self) -> None:
            """Идентификатор обращения: присланный шлюзом X-Request-ID или свой."""
            rid = self.headers.get("X-Request-ID", "")
            REQUEST.id = rid if REQUEST_ID.match(rid) else uuid.uuid4().hex

        def end_headers(self):
            if request_id():
                self.send_header("X-Request-ID", request_id())
            super().end_headers()

        def authorized(self) -> bool:
            return not token or hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}")

        def json(self, status: int, data: dict):
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ValueError("слишком большой запрос")
            data = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("ожидается JSON-объект")
            return data

        def do_GET(self):  # noqa: N802
            self.begin()
            if self.path == "/healthz":
                return self.json(200, {"ok": True})
            if not self.authorized():
                return self.json(401, {"error": "unauthorized"})
            if self.path == "/core/health":
                return self.json(200, app.health())
            if self.path == "/core/kb":
                return self.json(200, app.kb())
            if self.path == "/core/settings":
                return self.json(200, app.settings.snapshot(env("LLM_MODEL", "")))
            return self.json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            self.begin()
            if not self.authorized():
                return self.json(401, {"error": "unauthorized"})
            try:
                body = self.body()
                if self.path == "/core/chat":
                    return self.stream_chat(body)
                if self.path == "/core/settings":
                    app.settings.update(body.get("values"))
                    return self.json(200, app.settings.snapshot(env("LLM_MODEL", "")))
                if self.path == "/core/settings/reset":
                    app.settings.reset()
                    return self.json(200, app.settings.snapshot(env("LLM_MODEL", "")))
                return self.json(404, {"error": "not found"})
            except ValueError as exc:
                return self.json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                log("error", "запрос не обработан", error=f"{type(exc).__name__}: {exc}")
                return self.json(500, {"error": f"{type(exc).__name__}"})

        def stream_chat(self, body: dict):
            # Ошибки формата и пределы настроек песочницы — до начала потока, обычным 400.
            clean_turns(body.get("messages"))
            app.settings.overrides(body.get("overrides"))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            write_lock = threading.Lock()

            def emit(event: str, data: dict):
                chunk = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
                with write_lock:
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except OSError:
                        pass  # шлюз ушёл — ответ всё равно досчитаем, чтобы не оборвать модель на середине

            t0 = time.perf_counter()
            try:
                payload = app.chat(body, emit)
                emit("answer", payload)
                calls = payload.get("llm_calls") or []
                log("info", "ответ", answer_id=payload["id"], mode=payload["mode"], fallback=payload["fallback"],
                    error=payload["error"] or "", llm_calls=len(calls),
                    llm_errors=sum(1 for c in calls if c.get("error")),
                    took_ms=round((time.perf_counter() - t0) * 1000))
            except Exception as exc:  # noqa: BLE001
                log("error", "ответ не построен", error=f"{type(exc).__name__}: {exc}",
                    took_ms=round((time.perf_counter() - t0) * 1000))
                emit("error", {"error": f"{type(exc).__name__}: {exc}"})
            emit("done", {})

    return Handler


class DualStackServer(ThreadingHTTPServer):
    """Приватная сеть Railway адресует службы по IPv6, docker compose — по IPv4.

    Адрес «::» с выключенным IPV6_V6ONLY слушает оба семейства, поэтому один образ работает в обоих местах.
    """

    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass  # сокет и так двойной или IPv4 недоступен — слушаем что есть
        super().server_bind()


def main():
    host = env("EB_CORE_HOST", "127.0.0.1")
    # PORT задают хостинги; EB_CORE_PORT — своё имя для локального запуска.
    port = env_num("PORT", 0, 1, 65535) or env_num("EB_CORE_PORT", 8788, 1, 65535)
    app = App()
    server_cls = DualStackServer if ":" in host else ThreadingHTTPServer
    server = server_cls((host, port), make_handler(app))
    log("info", "ядро слушает", url=f"http://{host}:{port}/core/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
