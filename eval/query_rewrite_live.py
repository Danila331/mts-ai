"""Live-замер реального Qwen search_query и времени полного ответа."""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.dialog import parse  # noqa: E402
from energybot.llm import env, env_num  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402
from query_rewrite_eval import CASES  # noqa: E402


def main():
    bot = Consultant(ROOT / "knowledge-base", index_dir=ROOT / "index")
    workers = env_num("EB_LIVE_WORKERS", 7, 1, 16)
    os.environ["EB_QUERY_REWRITE"] = "0"
    states = [None] * len(CASES)
    state_seconds = [0.0] * len(CASES)

    def make_state(i):
        started = time.perf_counter()
        state = bot.dialog_state(parse(CASES[i]["question"]))
        return i, state, time.perf_counter() - started

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, state, elapsed in pool.map(make_state, range(len(CASES))):
            states[i] = state
            state_seconds[i] = elapsed

    def answer_one(args):
        i, rewrite = args
        os.environ["EB_QUERY_REWRITE"] = rewrite
        started = time.perf_counter()
        result = bot.answer(parse(CASES[i]["question"]), state=states[i])
        elapsed = time.perf_counter() - started
        have = {(doc, path) for doc, path, _ in result.sources}
        expected = CASES[i]["sources"]
        return i, {"seconds": elapsed, "timings": result.timings, "text": result.text,
                   "error": result.error, "guard": result.guard,
                   "context_full": expected <= have, "context_part": len(expected & have) / len(expected)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        old = list(pool.map(answer_one, [(i, "0") for i in range(len(CASES))]))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        new = list(pool.map(answer_one, [(i, "1") for i in range(len(CASES))]))
    old = [row for _, row in sorted(old)]
    new = [row for _, row in sorted(new)]

    print("Реальный Qwen search_query; полный ответ, не только поиск.")
    print(f"Reranker: {env('EB_USE_RERANKER', '1') != '0'}; workers: {workers}")
    print("| кейс | search_query | старый, с | новый, с | контекст старый/новый |")
    print("|---|---|---:|---:|---|")
    for i, case in enumerate(CASES):
        print(f"| {case['id']} | {states[i].get('search_query', '') or '∅'} | {old[i]['seconds']:.2f} | "
              f"{new[i]['seconds']:.2f} | {old[i]['context_full']}/{new[i]['context_full']} |")
    print(f"Среднее dialog_state: {statistics.mean(state_seconds):.2f} с")
    print(f"Среднее полное время: старый {statistics.mean(r['seconds'] for r in old):.2f} с, "
          f"новый {statistics.mean(r['seconds'] for r in new):.2f} с")
    print(f"Полное покрытие: старый {sum(r['context_full'] for r in old)}/{len(old)}, "
          f"новый {sum(r['context_full'] for r in new)}/{len(new)}")

    result = {"note": "Live Qwen search_query + полное время ответа",
              "mode": "hybrid" if bot.dense else "BM25", "reranker": env("EB_USE_RERANKER", "1") != "0",
              "states": [{"id": case["id"], "search_query": states[i].get("search_query", ""),
                          "seconds": state_seconds[i]} for i, case in enumerate(CASES)],
              "old": old, "new": new}
    out = ROOT / "eval" / "reports" / f"query-rewrite-live-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Отчёт: {out}")


if __name__ == "__main__":
    main()
