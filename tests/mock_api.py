"""Заглушка OpenAI-совместимого API платформы для офлайн-тестов.

Поведение настраивается при создании: можно имитировать отказ от
chat_template_kwargs, размышления <think> и сбои сервера.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def fake_vector(text: str, dim: int = 32) -> list:
    h = hashlib.sha256(text.encode("utf-8")).digest()
    return [((h[i % len(h)] / 255.0) - 0.5) for i in range(dim)]


class MockApi:
    DEFAULT_ANSWER = "<think>рассуждаю</think>\n**Да**, это возможно:\n- первый факт\n- второй факт\nКакой у вас регион?"

    def __init__(self, reject_template_kwargs=True, fail_chat=False, responder=None,
                 chat_delay=0.0, rerank_delay=0.0, embed_delay=0.0):
        """responder(messages) -> текст ответа модели; задержки имитируют время работы сервиса."""
        self.reject_template_kwargs = reject_template_kwargs
        self.fail_chat = fail_chat
        self.responder = responder
        self.delays = {"chat": chat_delay, "rerank": rerank_delay, "embeddings": embed_delay}
        self.lock = threading.Lock()
        self.calls = {"chat": 0, "embeddings": 0, "rerank": 0, "rejected": 0}
        self.last_messages = None
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # тишина в тестах
                pass

            def _send(self, code, payload):
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.headers.get("Authorization") != "Bearer test-key":
                    return self._send(401, {"error": "bad key"})
                kind = next((k for k in ("embeddings", "rerank") if self.path.endswith("/" + k)), "chat")
                time.sleep(mock.delays[kind])
                if self.path.endswith("/embeddings"):
                    with mock.lock:
                        mock.calls["embeddings"] += 1
                    data = [{"index": i, "embedding": fake_vector(t)} for i, t in enumerate(body["input"])]
                    return self._send(200, {"data": data})
                if self.path.endswith("/rerank"):
                    with mock.lock:
                        mock.calls["rerank"] += 1
                    q = set(body["query"].lower().split())
                    scored = [{"index": i, "relevance_score": len(q & set(d.lower().split())) / 10}
                              for i, d in enumerate(body["documents"])]
                    scored.sort(key=lambda x: -x["relevance_score"])
                    return self._send(200, {"results": scored[: body.get("top_n", len(scored))]})
                if self.path.endswith("/chat/completions"):
                    with mock.lock:
                        mock.calls["chat"] += 1
                    if mock.fail_chat:
                        return self._send(503, {"error": "overloaded"})
                    if mock.reject_template_kwargs and "chat_template_kwargs" in body:
                        mock.calls["rejected"] += 1
                        return self._send(400, {"error": "unknown field chat_template_kwargs"})
                    mock.last_messages = body["messages"]
                    content = mock.responder(body["messages"]) if mock.responder else mock.DEFAULT_ANSWER
                    return self._send(200, {"choices": [{"message": {"role": "assistant", "content": content}}]})
                return self._send(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
