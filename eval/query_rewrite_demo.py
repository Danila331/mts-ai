"""Полная проверка organizer demo: rewrite, retrieval, ответы, судья и все метрики."""

from __future__ import annotations

import csv
import json
import os
import statistics
import sys
import tempfile
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

from energybot.dialog import parse  # noqa: E402
from energybot.llm import env, env_num  # noqa: E402
from energybot.pipeline import Consultant, valid_search_query  # noqa: E402
from run_eval import build_data_dir, judge_api, judge_vs_baseline, platform_metrics, run_solution, style  # noqa: E402


def mean(values):
    return statistics.mean(values) if values else None


def json_safe(value):
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, set):
        return [json_safe(item) for item in sorted(value)]
    return value if isinstance(value, (str, int, float, bool)) or value is None else str(value)


def percentile(values, fraction=0.95):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def summarize_times(rows, key="seconds"):
    values = [row[key] for row in rows]
    return {"mean": mean(values), "median": statistics.median(values) if values else None,
            "p95": percentile(values), "min": min(values, default=None), "max": max(values, default=None),
            "total": sum(values)}


def write_csv(path, items, answers):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writerow(["id", "answer"])
        writer.writerows((item["id"], answers.get(item["id"], "")) for item in items)


def main():
    report_dir = ROOT / "eval" / "reports" / f"query-rewrite-demo-{time.strftime('%Y%m%d-%H%M%S')}"
    report_dir.mkdir(parents=True, exist_ok=True)
    with (ROOT / "demo_questions.csv").open(encoding="utf-8-sig", newline="") as f:
        questions = list(csv.DictReader(f))
    with (ROOT / "demo_output.csv").open(encoding="utf-8-sig", newline="") as f:
        references = {row["id"]: row["answer"] for row in csv.DictReader(f)}
    gold = {key: value for key, value in json.loads((ROOT / "eval" / "gold_demo.json").read_text(encoding="utf-8")).items()
            if not key.startswith("_")}
    items = [{"id": f"demo-{row['id']}", "question": row["question"], "reference": references.get(row["id"], ""),
              "type": "dialog" if "Ассистент:" in row["question"] else "single",
              "docs": set(gold.get(row["id"], []))} for row in questions]

    bot = Consultant(ROOT / "knowledge-base", index_dir=ROOT / "index")
    workers = env_num("EB_LIVE_WORKERS", 7, 1, 16)
    counts = Counter()
    counts_lock = threading.Lock()
    original_chat = bot.api.chat
    original_embed = bot.api.embed
    phase = {"name": "setup"}

    def counted_chat(*args, **kwargs):
        with counts_lock:
            counts[f"{phase['name']}_chat"] += 1
        return original_chat(*args, **kwargs)

    def counted_embed(*args, **kwargs):
        with counts_lock:
            counts[f"{phase['name']}_embed_calls"] += 1
            counts[f"{phase['name']}_embed_texts"] += len(args[0]) if args else 0
        return original_embed(*args, **kwargs)

    bot.api.chat = counted_chat
    bot.api.embed = counted_embed

    # 1. Реальные состояния и search_query по одному вызову на каждый диалог.
    phase["name"] = "state"
    states = [None] * len(items)
    state_times = [0.0] * len(items)

    def make_state(i):
        started = time.perf_counter()
        state = bot.dialog_state(parse(items[i]["question"]))
        return i, state, time.perf_counter() - started

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, state, elapsed in pool.map(make_state, range(len(items))):
            states[i] = state
            state_times[i] = elapsed

    def answer_one(args):
        i, rewrite = args
        os.environ["EB_QUERY_REWRITE"] = rewrite
        started = time.perf_counter()
        result = bot.answer(parse(items[i]["question"]), state=states[i])
        elapsed = time.perf_counter() - started
        expected = items[i]["docs"]
        candidate = {Path(doc).name for doc, _, _ in result.sources[:10]}
        context = {Path(doc).name for doc, _, _ in result.sources}
        return i, {"id": items[i]["id"], "seconds": elapsed, "timings": result.timings,
                   "text": result.text, "action": result.action, "error": result.error, "guard": result.guard,
                   "sources": result.sources,
                   "candidate_full": expected <= candidate if expected else None,
                   "candidate_part": len(expected & candidate) / len(expected) if expected else None,
                   "context_full": expected <= context if expected else None,
                   "context_part": len(expected & context) / len(expected) if expected else None}

    # 2. Полные ответы старого и нового варианта.
    phase["name"] = "old"
    with ThreadPoolExecutor(max_workers=workers) as pool:
        old = list(pool.map(answer_one, [(i, "0") for i in range(len(items))]))
    phase["name"] = "new"
    with ThreadPoolExecutor(max_workers=workers) as pool:
        new = list(pool.map(answer_one, [(i, "1") for i in range(len(items))]))
    old = [row for _, row in sorted(old)]
    new = [row for _, row in sorted(new)]

    # 3. Один бейзлайн для всех сравнений.
    phase["name"] = "baseline"
    baseline_dir = report_dir / "baseline"
    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "data"
        build_data_dir(items, ROOT / "knowledge-base", data_dir)
        baseline_answers, baseline_seconds = run_solution(ROOT / "sample_submission" / "solution.py", data_dir,
                                                          baseline_dir, debug=False)

    # 4. Судья по методике платформы: old/baseline, new/baseline, new/old.
    api = judge_api()
    verdicts = {"old": [None] * len(items), "new": [None] * len(items), "new_vs_old": [None] * len(items)}
    if api:
        def judge_one(args):
            i, mode = args
            if mode == "new_vs_old":
                score, reason = judge_vs_baseline(api, items[i]["question"], items[i]["reference"],
                                                  new[i]["text"], old[i]["text"])
            else:
                team = old if mode == "old" else new
                score, reason = judge_vs_baseline(api, items[i]["question"], items[i]["reference"],
                                                  team[i]["text"], baseline_answers.get(items[i]["id"], ""))
            return mode, i, {"score": score, "reason": reason}

        jobs = [(i, mode) for mode in verdicts for i in range(len(items))]
        with ThreadPoolExecutor(max_workers=env_num("EB_JUDGE_WORKERS", 30, 1, 32)) as pool:
            for mode, i, verdict in pool.map(judge_one, jobs):
                verdicts[mode][i] = verdict

    # 5. Все агрегаты и сырые данные.
    summary = {
        "mode": "hybrid" if bot.dense else "BM25", "reranker": env("EB_USE_RERANKER", "1") != "0",
        "workers": workers, "cases": len(items),
        "search_query": {
            "nonempty": sum(bool(states[i].get("search_query")) for i in range(len(items))),
            "valid": sum(bool(valid_search_query(states[i], states[i]["last_question"])) for i in range(len(items))),
            "seconds": summarize_times([{"seconds": value} for value in state_times]),
        },
        "old": {"time": summarize_times(old), "candidate_full": sum(bool(r["candidate_full"]) for r in old),
                "context_full": sum(bool(r["context_full"]) for r in old),
                "candidate_part": mean([r["candidate_part"] for r in old if r["candidate_part"] is not None]),
                "context_part": mean([r["context_part"] for r in old if r["context_part"] is not None]),
                "errors": sum(bool(r["error"]) for r in old), "actions": dict(Counter(r["action"] for r in old)),
                "guard": dict(Counter(k for r in old for k in r["guard"])),
                "style": style([r["text"] for r in old]), "judge": platform_metrics([v["score"] for v in verdicts["old"]])},
        "new": {"time": summarize_times(new), "candidate_full": sum(bool(r["candidate_full"]) for r in new),
                "context_full": sum(bool(r["context_full"]) for r in new),
                "candidate_part": mean([r["candidate_part"] for r in new if r["candidate_part"] is not None]),
                "context_part": mean([r["context_part"] for r in new if r["context_part"] is not None]),
                "errors": sum(bool(r["error"]) for r in new), "actions": dict(Counter(r["action"] for r in new)),
                "guard": dict(Counter(k for r in new for k in r["guard"])),
                "style": style([r["text"] for r in new]), "judge": platform_metrics([v["score"] for v in verdicts["new"]])},
        "new_vs_old": platform_metrics([v["score"] for v in verdicts["new_vs_old"]]),
        "baseline": {"seconds": baseline_seconds, "fallbacks": sum("Не могу ответить" in a for a in baseline_answers.values()),
                     "style": style([baseline_answers.get(item["id"], "") for item in items])},
        "reference_style": style([item["reference"] for item in items]),
        "api_calls": dict(counts),
        "timing_means": {
            name: {
                "old": mean([r["timings"].get(name, 0.0) for r in old]),
                "new": mean([r["timings"].get(name, 0.0) for r in new]),
            } for name in ("state", "retrieval", "ambiguity", "evidence", "generation", "guard", "calculation", "total")
        },
    }

    raw = {"summary": summary, "items": items, "states": states, "old": old, "new": new,
           "baseline": baseline_answers, "verdicts": verdicts}
    (report_dir / "metrics.json").write_text(json.dumps(json_safe(raw), ensure_ascii=False, indent=2), encoding="utf-8")
    (report_dir / "summary.json").write_text(json.dumps(json_safe(summary), ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(report_dir / "old_predictions.csv", items, {r["id"]: r["text"] for r in old})
    write_csv(report_dir / "new_predictions.csv", items, {r["id"]: r["text"] for r in new})
    write_csv(report_dir / "baseline_predictions.csv", items, baseline_answers)

    lines = ["# Organizer demo: query rewrite — все метрики", "",
             f"Режим: {summary['mode']}; reranker: {summary['reranker']}; кейсов: {len(items)}", "",
             f"search_query: {summary['search_query']['nonempty']} непустых, {summary['search_query']['valid']} валидных; "
             f"среднее dialog_state {summary['search_query']['seconds']['mean']:.2f} с", "",
             "| метрика | старый | новый |", "|---|---:|---:|"]
    for label, key in (("Среднее время, с", "mean"), ("Медиана, с", "median"), ("P95, с", "p95"), ("Максимум, с", "max")):
        lines.append(f"| {label} | {summary['old']['time'][key]:.2f} | {summary['new']['time'][key]:.2f} |")
    for label, key in (("Кандидаты full", "candidate_full"), ("Контекст full", "context_full")):
        lines.append(f"| {label} | {summary['old'][key]}/{len(items)} | {summary['new'][key]}/{len(items)} |")
    for mode in ("old", "new"):
        judge = summary[mode]["judge"]
        if judge["n"]:
            lines.append(f"| Score {mode} | {judge['score']:.3f} | n={judge['n']} |")
    comparison = summary["new_vs_old"]
    if comparison["n"]:
        lines.append(f"| Новый против старого | {comparison['score']:.3f} | n={comparison['n']} |")
    lines += ["", f"Бейзлайн: отказов {summary['baseline']['fallbacks']}/{len(items)}", "",
              "| кейс | search_query | старый, с | новый, с | контекст старый/новый | old judge | new judge |",
              "|---|---|---:|---:|---|---:|---:|"]
    for i, item in enumerate(items):
        old_score = verdicts["old"][i]["score"]
        new_score = verdicts["new"][i]["score"]
        lines.append(f"| {item['id']} | {states[i].get('search_query', '') or '∅'} | {old[i]['seconds']:.2f} | "
                     f"{new[i]['seconds']:.2f} | {old[i]['context_full']}/{new[i]['context_full']} | "
                     f"{old_score if old_score is not None else '—'} | {new_score if new_score is not None else '—'} |")
    lines += ["", "## Ответы и вердикты", ""]
    for i, item in enumerate(items):
        lines += [f"### {item['id']}", "", f"Вопрос: {item['question']}", "",
                  f"Старый: {old[i]['text']}", "", f"Новый: {new[i]['text']}", "",
                  f"Эталон: {item['reference']}", "",
                  f"Old judge: {verdicts['old'][i]}", f"New judge: {verdicts['new'][i]}",
                  f"New vs old: {verdicts['new_vs_old'][i]}", ""]
    (report_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:35]))
    print(f"Отчёт: {report_dir}")


if __name__ == "__main__":
    main()
