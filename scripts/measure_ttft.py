"""Замер скорости ответа стенда (T13): время до первого куска текста и до готового ответа.

Ходит в поднятый API — ядро (/core/chat) или Go-API (/api/chat) — и по каждому вопросу засекает:
  first_delta — первое событие delta (клиент видит начало текста);
  answer      — событие answer (готовый, проверенный ответ);
  first_text  — когда клиент впервые видит текст: первая delta, а без потока — answer.

«До/после» одним прогоном: --compare шлёт каждый вопрос с "stream": false (как было до T13) и с потоком.
Поле stream понимает только ядро; через Go-API «до» — перезапуск ядра с EB_STREAM=0.

Платная модель для замера не нужна — заглушка tests/mock_api.py отвечает с задержкой и по слову:

    .venv/bin/python tests/mock_api.py --port 8790 --chat-delay 0.8 --token-delay 0.05 &
    env -i PATH="$PATH" LLM_BASE_URL=http://127.0.0.1:8790/v1 LLM_API_KEY=test-key EB_USE_EMBEDDINGS=0 \\
        EB_USE_RERANKER=0 EB_CORE_PORT=8788 .venv/bin/python scripts/core_api.py &
    .venv/bin/python scripts/measure_ttft.py --url http://127.0.0.1:8788/core/chat --compare --runs 3

Только стандартная библиотека; ключи модели скрипту не нужны (токен ядра — --token или EB_CORE_TOKEN).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

QUESTIONS = [
    "Что нужно, чтобы подключить платформу учёта электроэнергии?",
    "Окупится ли солнечная станция на крыше склада?",
    "Как найти, где теряется электроэнергия в сетях СНТ?",
]


def ask(url: str, question: str, token: str, stream: bool | None, mode: str, timeout: float) -> dict:
    """Один вопрос → отметки времени в мс от отправки запроса."""
    body = {"messages": [{"role": "user", "content": question}], "mode": mode}
    if stream is not None:
        body["stream"] = stream
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    t0 = time.perf_counter()
    marks = {"first_delta": None, "answer": None, "deltas": 0, "revised": None, "fallback": None}
    event, data = "message", []
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw in response:
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
            elif not line and data:
                ms = round((time.perf_counter() - t0) * 1000)
                payload = json.loads("\n".join(data))
                if event == "delta":
                    marks["deltas"] += 1
                    marks["first_delta"] = marks["first_delta"] or ms
                elif event == "answer":
                    marks["answer"] = ms
                    marks["revised"], marks["fallback"] = payload.get("revised"), payload.get("fallback")
                elif event == "error":
                    raise RuntimeError(payload.get("error") or "ошибка ответа")
                event, data = "message", []
    if marks["answer"] is None:
        raise RuntimeError("поток кончился без answer")
    marks["first_text"] = marks["first_delta"] or marks["answer"]
    return marks


def summary(rows: list) -> dict:
    out = {}
    for key in ("first_text", "first_delta", "answer"):
        values = [r[key] for r in rows if r[key] is not None]
        out[key] = {"median": round(statistics.median(values)), "mean": round(statistics.mean(values)),
                    "max": max(values)} if values else None
    out["deltas"] = round(statistics.mean(r["deltas"] for r in rows), 1)
    out["revised"] = sum(bool(r["revised"]) for r in rows)
    out["fallback"] = sum(bool(r["fallback"]) for r in rows)
    out["n"] = len(rows)
    return out


def fmt(value: dict | None) -> str:
    return "—" if value is None else f"{value['median']} мс (ср. {value['mean']}, макс. {value['max']})"


def main():
    parser = argparse.ArgumentParser(description="Время до первого куска текста и до готового ответа")
    parser.add_argument("--url", default="http://127.0.0.1:8788/core/chat",
                        help="ядро /core/chat или Go-API /api/chat")
    parser.add_argument("--token", default=os.getenv("EB_CORE_TOKEN", ""), help="токен ядра (Bearer), если задан")
    parser.add_argument("--runs", type=int, default=3, help="сколько раз задать каждый вопрос")
    parser.add_argument("--mode", default="chat", choices=("chat", "eval", "copilot"))
    parser.add_argument("--compare", action="store_true", help='"до/после": stream false и true (только ядро)')
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--json", action="store_true", help="итог одной строкой JSON")
    args = parser.parse_args()

    variants = [("до (stream: false)", False), ("после (поток)", True)] if args.compare else [("как есть", None)]
    ask(args.url, QUESTIONS[0], args.token, variants[0][1], args.mode, args.timeout)  # прогрев: индекс, соединения
    results = {}
    for name, stream in variants:
        rows = []
        for _ in range(args.runs):
            for question in QUESTIONS:
                rows.append(ask(args.url, question, args.token, stream, args.mode, args.timeout))
        results[name] = summary(rows)

    if args.json:
        print(json.dumps(results, ensure_ascii=False))
        return
    print(f"{args.url}, режим {args.mode}, вопросов: {len(QUESTIONS)} × {args.runs}")
    for name, s in results.items():
        print(f"\n{name}")
        print(f"  до первого текста: {fmt(s['first_text'])}")
        print(f"  до первой delta:   {fmt(s['first_delta'])}")
        print(f"  до answer:         {fmt(s['answer'])}")
        print(f"  дельт на ответ: {s['deltas']}, уточнено проверкой: {s['revised']}/{s['n']}, "
              f"запасных: {s['fallback']}/{s['n']}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as exc:
        print(f"замер не удался: {exc}", file=sys.stderr)
        sys.exit(1)
