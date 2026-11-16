"""Заглушка OpenAI-совместимого API платформы для офлайн-тестов.

Поведение настраивается при создании: можно имитировать отказ от
chat_template_kwargs, размышления <think>, сбои сервера и скорость генерации:
chat_delay — до первого токена, token_delay — между словами ответа. С "stream": true
ответ идёт SSE-кусками по слову (как у vLLM / OpenAI), без него — целиком после той же
задержки на генерацию.

Отдельным процессом — для замера скорости стенда (scripts/measure_ttft.py), без платной модели:

    .venv/bin/python tests/mock_api.py --port 8790 --chat-delay 0.8 --token-delay 0.05
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def fake_vector(text: str, dim: int = 32) -> list:
    h = hashlib.sha256(text.encode("utf-8")).digest()
    return [((h[i % len(h)] / 255.0) - 0.5) for i in range(dim)]


class MockApi:
    DEFAULT_ANSWER = "<think>рассуждаю</think>\n**Да**, это возможно:\n- первый факт\n- второй факт\nКакой у вас регион?"

    def __init__(self, reject_template_kwargs=True, fail_chat=False, responder=None,
                 chat_delay=0.0, rerank_delay=0.0, embed_delay=0.0, max_embed_batch=None, chat_drip=0.0,
                 token_delay=0.0, stream_supported=True, port=0):
        """responder(messages) -> текст ответа модели; задержки имитируют время работы сервиса.

        token_delay — пауза на каждое слово ответа (в потоке — между кусками, без потока — суммой до ответа);
        stream_supported=False — сервер игнорирует "stream": true и отвечает целиком JSON."""
        self.reject_template_kwargs = reject_template_kwargs
        self.fail_chat = fail_chat
        self.responder = responder
        self.max_embed_batch = max_embed_batch
        self.chat_drip = chat_drip  # >0: тело ответа чата отдаётся по байту с такой паузой
        self.token_delay = token_delay
        self.stream_supported = stream_supported
        self.delays = {"chat": chat_delay, "rerank": rerank_delay, "embeddings": embed_delay}
        self.lock = threading.Lock()
        self.calls = {"chat": 0, "embeddings": 0, "rerank": 0, "rejected": 0, "stream": 0}
        self.last_messages = None
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # тишина в тестах
                pass

            def _send(self, code, payload, drip=0.0):
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not drip:
                    self.wfile.write(body)
                    return
                try:  # «капающий» ответ: каждая порция быстрее тайм-аута чтения, весь ответ — очень долго
                    for i in range(len(body)):
                        self.wfile.write(body[i:i + 1])
                        self.wfile.flush()
                        time.sleep(drip)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.headers.get("Authorization") != "Bearer test-key":
                    return self._send(401, {"error": "bad key"})
                kind = next((k for k in ("embeddings", "rerank") if self.path.endswith("/" + k)), "chat")
                time.sleep(mock.delays[kind])
                if self.path.endswith("/embeddings"):
                    if mock.max_embed_batch and len(body["input"]) > mock.max_embed_batch:
                        return self._send(400, {"error": "batch size is invalid"})
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
                    pieces = re.findall(r"\s*\S+", content) or [content]
                    if body.get("stream") and mock.stream_supported:
                        with mock.lock:
                            mock.calls["stream"] += 1
                        return self._stream(pieces)
                    time.sleep(mock.token_delay * len(pieces))  # генерация та же, просто ответ — целиком
                    return self._send(200, {"choices": [{"message": {"role": "assistant", "content": content},
                                                         "finish_reason": "stop"}]},
                                      drip=mock.chat_drip)
                return self._send(404, {"error": "not found"})

            def _stream(self, pieces):
                """SSE как у OpenAI-совместимых серверов: delta.content по слову, finish_reason, [DONE]."""
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()

                def chunk(delta, finish=None):
                    data = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode()

                try:
                    self.wfile.write(chunk({"role": "assistant"}))
                    start = time.perf_counter()
                    for i, piece in enumerate(pieces):
                        # По расписанию от начала, а не паузой после каждого куска: иначе погрешность sleep
                        # копится, и поток выходил бы медленнее ответа целиком при той же «скорости модели».
                        time.sleep(max(0.0, start + i * mock.token_delay - time.perf_counter()))
                        self.wfile.write(chunk({"content": piece}))
                        self.wfile.flush()
                    self.wfile.write(chunk({}, "stop") + b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.server.block_on_close = False  # не ждать «капающие» ответы при остановке
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


# Ответ для замера скорости: длиной с типичный ответ консультанта и без чисел — проверка ответа его не трогает,
# поэтому замер показывает чистую задержку генерации, а не перезапросы guard.
MEASURE_ANSWER = (
    "Платформа учёта собирает показания приборов автоматически и показывает расход по каждому объекту в одном "
    "кабинете. Для подключения нужен перечень приборов учёта с их типами и способом связи, после этого специалисты "
    "проверяют совместимость и предлагают схему опроса. Если часть приборов не поддерживает удалённый опрос, их "
    "можно заменить или дооснастить модемами. Подскажите, сколько у вас объектов и какие приборы уже установлены?"
)


def main():
    parser = argparse.ArgumentParser(description="Заглушка OpenAI-совместимого API (ключ: test-key)")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--chat-delay", type=float, default=0.8, help="до первого токена, с")
    parser.add_argument("--token-delay", type=float, default=0.05, help="между словами ответа, с")
    parser.add_argument("--no-stream", action="store_true", help="сервер не умеет stream: true")
    parser.add_argument("--revise", action="store_true",
                        help="основной ответ с выдуманным числом: проверка перезапросит его (метка «Уточнено проверкой»)")
    args = parser.parse_args()

    def responder(messages):
        repair = str(messages[-1]["content"]).startswith("[Служебная")
        return MEASURE_ANSWER if repair or not args.revise else MEASURE_ANSWER + " Подключение займёт 37 дней."

    mock = MockApi(reject_template_kwargs=False, responder=responder,
                   chat_delay=args.chat_delay, token_delay=args.token_delay,
                   stream_supported=not args.no_stream, port=args.port)
    print(f"заглушка модели: {mock.url} (ключ test-key)", flush=True)
    try:
        mock.server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
