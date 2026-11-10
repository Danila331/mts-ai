"""A/B компактного контекста на общих снимках RAG и классификатора."""

from __future__ import annotations

import copy
import csv
import json
import os
import statistics
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

from energybot.dialog import parse  # noqa: E402
from energybot.llm import env, env_num  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402
from query_rewrite_demo import json_safe, mean, summarize_times, write_csv  # noqa: E402
from run_eval import build_data_dir, judge_api, judge_vs_baseline, platform_metrics, run_solution, style  # noqa: E402


def main():
    os.environ["EB_QUERY_REWRITE"] = "0"
    os.environ["EB_ENSEMBLE"] = "0"
    report_dir = ROOT / "eval" / "reports" / f"compact-evidence-demo-{time.strftime('%Y%m%d-%H%M%S')}"
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

    # Общий снимок: RAG и решение классификатора вызываются ровно один раз на кейс.
    def prepare(i):
        turns = parse(items[i]["question"])
        state = bot.dialog_state(turns)
        hits, chunks = bot.retrieve(turns, state=state)
        decision = bot.ambiguity.classify(turns, state, "\n\n".join(c.render() for c in chunks))
        sources = [(h.chunk.doc, h.chunk.path, round(float(h.score), 4)) for h in hits]
        sources += [(c.doc, c.path, None) for c in chunks[len(hits):]]
        return i, {"turns": turns, "state": state, "hits": hits, "chunks": chunks,
                   "sources": sources, "decision": decision,
                   "materials": "\n\n".join(c.render() for c in chunks)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        snapshots = list(pool.map(prepare, range(len(items))))
    snapshots = [snapshot for _, snapshot in sorted(snapshots)]

    def answer_one(args):
        i, compact = args
        snapshot = snapshots[i]
        os.environ["EB_COMPACT_EVIDENCE"] = "1" if compact else "0"
        case_bot = copy.copy(bot)
        case_bot.ambiguity = copy.copy(bot.ambiguity)
        case_bot.retrieve = lambda *a, **kw: (snapshot["hits"], snapshot["chunks"])
        case_bot.ambiguity.classify = lambda *a, **kw: snapshot["decision"]
        started = time.perf_counter()
        result = case_bot.answer(snapshot["turns"], state=snapshot["state"])
        elapsed = time.perf_counter() - started
        expected = items[i]["docs"]
        candidate = {Path(doc).name for doc, _, _ in result.sources[:10]}
        context = {Path(doc).name for doc, _, _ in result.sources}
        evidence = result.guard.get("evidence", {})
        decision = snapshot["decision"]
        eligible = decision["action"] in ("answer", "answer_and_clarify") or (
            decision["action"] == "clarify" and decision.get("direct_answer_available", False))
        rag_docs = {Path(chunk.doc).name for chunk in snapshot["chunks"]}
        return i, {"id": items[i]["id"], "seconds": elapsed, "timings": result.timings,
                   "text": result.text, "action": result.action, "error": result.error, "guard": result.guard,
                   "sources": result.sources, "evidence": evidence,
                   "context_chars": evidence.get("context_chars", len(snapshot["materials"])),
                   "fallback_reason": evidence.get("fallback_reason", ""),
                   "candidate_full": expected <= candidate if expected else None,
                   "context_full": expected <= context if expected else None,
                   "generation_eligible": eligible,
                   "rag_has_required": expected <= rag_docs if expected else False}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        old = list(pool.map(answer_one, [(i, False) for i in range(len(items))]))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        new = list(pool.map(answer_one, [(i, True) for i in range(len(items))]))
    old = [row for _, row in sorted(old)]
    new = [row for _, row in sorted(new)]

    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "data"
        build_data_dir(items, ROOT / "knowledge-base", data_dir)
        baseline_answers, baseline_seconds = run_solution(ROOT / "sample_submission" / "solution.py", data_dir,
                                                          report_dir / "baseline", debug=False)

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

    eligible_ids = [i for i in range(len(items)) if old[i]["generation_eligible"] and old[i]["rag_has_required"]]
    summary = {
        "cases": len(items), "eligible_with_rag": len(eligible_ids),
        "settings": {"query_rewrite": False, "ensemble": False, "reranker": env("EB_USE_RERANKER", "1") != "0",
                     "model": bot.api.llm_model, "temperature": bot.api.temperature,
                     "max_tokens": bot.api.max_tokens, "workers": workers},
        "old": {"time": summarize_times(old), "score": platform_metrics([v["score"] for v in verdicts["old"]]),
                "context_full": sum(bool(r["context_full"]) for r in old),
                "context_chars_mean": mean([r["context_chars"] for r in old]),
                "errors": sum(bool(r["error"]) for r in old), "style": style([r["text"] for r in old])},
        "new": {"time": summarize_times(new), "score": platform_metrics([v["score"] for v in verdicts["new"]]),
                "context_full": sum(bool(r["context_full"]) for r in new),
                "context_chars_mean": mean([r["context_chars"] for r in new]),
                "errors": sum(bool(r["error"]) for r in new), "style": style([r["text"] for r in new]),
                "fallbacks": dict(Counter(r["fallback_reason"] for r in new if r["fallback_reason"]))},
        "new_vs_old": platform_metrics([v["score"] for v in verdicts["new_vs_old"]]),
        "eligible_scores": {
            "old": platform_metrics([verdicts["old"][i]["score"] for i in eligible_ids]),
            "new": platform_metrics([verdicts["new"][i]["score"] for i in eligible_ids]),
            "new_vs_old": platform_metrics([verdicts["new_vs_old"][i]["score"] for i in eligible_ids]),
        },
        "baseline": {"seconds": baseline_seconds, "fallbacks": sum("Не могу ответить" in a for a in baseline_answers.values())},
    }
    raw = {"summary": summary, "items": items, "snapshots": snapshots, "old": old, "new": new,
           "baseline": baseline_answers, "verdicts": verdicts}
    (report_dir / "metrics.json").write_text(json.dumps(json_safe(raw), ensure_ascii=False, indent=2), encoding="utf-8")
    (report_dir / "summary.json").write_text(json.dumps(json_safe(summary), ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(report_dir / "old_predictions.csv", items, {r["id"]: r["text"] for r in old})
    write_csv(report_dir / "new_predictions.csv", items, {r["id"]: r["text"] for r in new})
    write_csv(report_dir / "baseline_predictions.csv", items, baseline_answers)

    def ids(row):
        return ", ".join(f"{item['id']} ({item['doc']} | {item['path']})"
                         for item in row["evidence"].get("selected", [])) or "—"

    lines = ["# A/B компактного контекста", "",
             f"EB_QUERY_REWRITE=0; EB_ENSEMBLE=0; reranker={summary['settings']['reranker']}", "",
             "| метрика | текущий | компактный |", "|---|---:|---:|",
             f"| Score | {summary['old']['score']['score']:.3f} | {summary['new']['score']['score']:.3f} |",
             f"| Контекст full | {summary['old']['context_full']}/{len(items)} | {summary['new']['context_full']}/{len(items)} |",
             f"| Символы в материалах, среднее | {summary['old']['context_chars_mean']:.0f} | {summary['new']['context_chars_mean']:.0f} |",
             f"| Время, среднее | {summary['old']['time']['mean']:.2f} | {summary['new']['time']['mean']:.2f} |",
             f"| Время, медиана | {summary['old']['time']['median']:.2f} | {summary['new']['time']['median']:.2f} |",
             f"| Новый против старого | {summary['new_vs_old']['score']:.3f} | n={summary['new_vs_old']['n']} |",
             f"| Generation + RAG | {summary['eligible_with_rag']} кейсов | — |", "",
             "| кейс | старый, с | новый, с | контекст старый/новый | old judge | new judge | fallback |",
             "|---|---:|---:|---|---:|---:|---|"]
    for i, item in enumerate(items):
        old_score = verdicts["old"][i]["score"]
        new_score = verdicts["new"][i]["score"]
        lines.append(f"| {item['id']} | {old[i]['seconds']:.2f} | {new[i]['seconds']:.2f} | "
                     f"{old[i]['context_full']}/{new[i]['context_full']} | {old_score} | {new_score} | "
                     f"{new[i]['fallback_reason'] or '—'} |")
    for special in ("demo-4", "demo-15", "demo-18"):
        i = next(index for index, item in enumerate(items) if item["id"] == special)
        lines += ["", f"## {special}", "", f"Вопрос: {items[i]['question']}", "",
                  f"ID компактного режима: {ids(new[i])}", "",
                  f"Текущий ответ: {old[i]['text']}", "",
                  f"Компактный ответ: {new[i]['text']}", "",
                  f"Эталон: {items[i]['reference']}", "",
                  f"Old judge: {verdicts['old'][i]}", f"New judge: {verdicts['new'][i]}",
                  f"New vs old: {verdicts['new_vs_old'][i]}", ""]
    (report_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:25]))
    print(f"Отчёт: {report_dir}")


if __name__ == "__main__":
    main()
