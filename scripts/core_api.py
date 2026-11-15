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
    POST /core/chat             {"messages": [{"role", "content"}], "mode": "chat"|"eval", "overrides": {ключ: значение}}
                                → SSE: stage, answer, done. overrides — настройки RAG только для этого ответа
                                (песочница стенда), те же ключи и пределы, что у /core/settings
    GET  /core/settings         настройки RAG: текущие значения, значения из окружения, пределы
    POST /core/settings         {"values": {ключ: значение}} — поменять на лету для всех ответов (до перезапуска)
    POST /core/settings/reset   вернуть значения из окружения
"""

from __future__ import annotations

import hmac
import io
import json
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

import index_cache  # noqa: E402 — scripts/index_cache.py, рядом с этим файлом

from energybot.dialog import search_queries  # noqa: E402
from energybot.guard import SENTENCE, numbers  # noqa: E402
from energybot.kb import KnowledgeBase  # noqa: E402
from energybot.llm import Api, env, env_num  # noqa: E402
from energybot.pipeline import FALLBACK, Consultant  # noqa: E402
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


class WebApi(Api):
    """Api стенда: параметры генерации и реранкер переопределяются на один ответ."""

    max_tokens = Overridable()
    temperature = Overridable()
    can_rerank = Overridable()


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

    def retrieve(self, turns, *args, **kwargs):
        result = super().retrieve(turns, *args, **kwargs)
        if len(result) == 3:  # (выдача, документы целиком, фрагменты)
            TRACE.docs, TRACE.chunks = list(result[1]), list(result[2])
        else:  # (лучшие фрагменты, контекст)
            TRACE.docs, TRACE.chunks = [], list(result[1])
        self._after_search(turns)
        return result

    def fm_search(self, turns, *args, **kwargs):  # схема factmap (есть не во всех версиях ядра)
        top = super().fm_search(turns, *args, **kwargs)
        TRACE.docs, TRACE.chunks = [], list(top)
        self._after_search(turns)
        return top

    def _after_search(self, turns):
        lexical, semantic, last = search_queries(turns)
        TRACE.queries = {"lexical": lexical, "semantic": semantic, "last": last}
        if TRACE.emit:
            TRACE.emit("stage", {"name": "retrieval", **self.retrieval_payload()})

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
        return {
            "arch": self.arch,
            "dense": self.dense,
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
    def __init__(self):
        kb_path = Path(env("EB_KB_PATH", str(ROOT / "knowledge-base")))
        self.api = WebApi()
        t0 = time.perf_counter()
        index_dir, from_cache = self.index_dir(kb_path)
        self.bot = WebConsultant(kb_path, index_dir=index_dir, api=self.api)
        saved = index_dir is not None and env("EB_INDEX_CACHE_DIR") != "" and \
            index_cache.save(self.bot.retriever, index_dir)
        log("info", "индекс готов", dense=self.bot.dense, from_cache=from_cache, saved=bool(saved),
            took_ms=round((time.perf_counter() - t0) * 1000), cache=str(index_dir or ""))
        self.mode = env("EB_WEB_MODE", "chat")
        self.settings = Settings(self.bot, self.api)
        self.kb_path = kb_path
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
        mode = body.get("mode") if body.get("mode") in ("chat", "eval") else self.mode
        applied, values = self.settings.overrides(body.get("overrides"))
        # Весь ответ — и поиск, и представление для отладки — с настройками этого запроса.
        with overridden(values):
            payload = self._chat(turns, mode, emit)
        payload["overrides"] = applied
        return payload

    def _chat(self, turns: list, mode: str, emit) -> dict:
        TRACE.reset(emit)
        t0 = time.perf_counter()
        answer = self.bot.answer(turns, mode=mode)
        total = (time.perf_counter() - t0) * 1000
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
        payload = {
            "id": uuid.uuid4().hex,
            "text": answer.text,
            "fallback": answer.text == FALLBACK or bool(answer.error),
            "error": answer.error,
            "mode": mode,
            "timings": {k: round(v * 1000) for k, v in answer.timings.items()} | {"server_total": round(total)},
            "guard": answer.guard,
            "trace": getattr(answer, "trace", ""),
            "sources": sources,
            "citations": attribute(answer.text, chunks),
            "retrieval": self.bot.retrieval_payload() if TRACE.ranked or TRACE.chunks else None,
            "prompt": prompt,
            "prompt_chars": sum(len(m["content"]) for m in prompt),
            "llm_calls": calls,
            "model": env("LLM_MODEL", ""),
        }
        # Подписи к источникам: путь раздела для чипов в ответе.
        for cite in payload["citations"]:
            for s in cite["support"]:
                s["title"] = by_id[s["id"]].title if s["id"] in by_id else s["doc"]
        return payload


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
