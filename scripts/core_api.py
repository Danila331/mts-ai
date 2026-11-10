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
    POST /core/chat             {"messages": [{"role", "content"}], "mode": "chat"|"eval"} → SSE: stage, answer, done
"""

from __future__ import annotations

import hmac
import json
import os
import socket
import sys
import threading
import time
import uuid
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

from energybot.dialog import search_queries  # noqa: E402
from energybot.guard import SENTENCE, numbers  # noqa: E402
from energybot.llm import Api, env, env_num  # noqa: E402
from energybot.pipeline import FALLBACK, Consultant  # noqa: E402
from energybot.text import tokens  # noqa: E402

MAX_BODY = 256_000
MAX_TURNS = 40


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


class WebConsultant(Consultant):
    """Тот же Consultant, что у solution.py, плюс запись выдачи поиска, контекста и вызовов модели.

    Перехват не зависит от версии ядра: выдача — из Retriever.search, промпт — из Api.chat, контекст — из
    результата retrieve (в одних версиях это (выдача, контекст), в других — (выдача, документы, фрагменты)).
    """

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


# ---------- приложение ----------
class App:
    def __init__(self):
        kb_path = Path(env("EB_KB_PATH", str(ROOT / "knowledge-base")))
        self.api = Api()
        self.bot = WebConsultant(kb_path, index_dir=ROOT / "index", api=self.api)
        self.mode = env("EB_WEB_MODE", "chat")

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
                print(f"[core] {self.command} {self.path} {args[1] if len(args) > 1 else ''}", file=sys.stderr)

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
            if self.path == "/healthz":
                return self.json(200, {"ok": True})
            if not self.authorized():
                return self.json(401, {"error": "unauthorized"})
            if self.path == "/core/health":
                return self.json(200, app.health())
            if self.path == "/core/kb":
                return self.json(200, app.kb())
            return self.json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if not self.authorized():
                return self.json(401, {"error": "unauthorized"})
            try:
                body = self.body()
                if self.path == "/core/chat":
                    return self.stream_chat(body)
                return self.json(404, {"error": "not found"})
            except ValueError as exc:
                return self.json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                print(f"[core] {type(exc).__name__}: {exc}", file=sys.stderr)
                return self.json(500, {"error": f"{type(exc).__name__}"})

        def stream_chat(self, body: dict):
            clean_turns(body.get("messages"))  # ошибки формата — до начала потока, обычным 400
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

            try:
                emit("answer", app.chat(body, emit))
            except Exception as exc:  # noqa: BLE001
                print(f"[core] chat: {type(exc).__name__}: {exc}", file=sys.stderr)
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
    print(f"[core] ядро: http://{host}:{port}/core/health", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
