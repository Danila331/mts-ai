"""Сравнение конфигураций генерации на одном фиксированном наборе кейсов.

Каждая конфигурация запускается в отдельном процессе и получает свой каталог
отчёта. Экспериментальные флаги явно сбрасываются, чтобы настройки текущей
оболочки не смешивали эксперименты. Первый успешный прогон становится базой
для попарного сравнения баллов по одним и тем же вопросам.

Пример:
    python eval/ablation.py --set dev --limit 50 --with-demo
    python eval/ablation.py --configs ensemble_verify,one_pass,verify_only --set demo

Holdout специально не выбирается по умолчанию: он нужен только для финальной
проверки уже выбранной конфигурации.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from run_eval import platform_metrics  # noqa: E402

# Порядок важен: текущая конфигурация — база для попарных сравнений.
CONFIGS = {
    "ensemble_verify": {"EB_VERIFY": "1", "EB_ENSEMBLE": "1"},
    "one_pass": {"EB_VERIFY": "0", "EB_ENSEMBLE": "0"},
    "verify_only": {"EB_VERIFY": "1", "EB_ENSEMBLE": "0"},
    "facts_only": {"EB_FACTS_COMPOSE": "1", "EB_VERIFY": "0", "EB_ENSEMBLE": "0"},
    "facts_verify": {"EB_FACTS_COMPOSE": "1", "EB_VERIFY": "1", "EB_ENSEMBLE": "0"},
    "llm_select": {"EB_LLM_SELECT": "1", "EB_VERIFY": "0", "EB_ENSEMBLE": "0"},
}

EXPERIMENT_DEFAULTS = {
    "EB_VERIFY": "0",
    "EB_ENSEMBLE": "0",
    "EB_FACTS_COMPOSE": "0",
    "EB_LLM_SELECT": "0",
    "EB_SENT_RERANK": "0",
    "EB_REF_MIX": "1",
    "EB_DIALOG_STATE": "1",
    "EB_MULTI_QUERY": "1",
    "EB_SLOT_CONTEXT": "1",
    "EB_EVIDENCE_FIRST": "1",
    "EB_CANDIDATE_SELECT": "1",
    "EB_CLAIM_GUARD": "1",
}


def config_env(name: str) -> dict:
    """Независимая копия окружения без протекания флагов между прогонами."""
    if name not in CONFIGS:
        raise ValueError(f"Неизвестная конфигурация: {name}")
    result = dict(os.environ)
    result.update(EXPERIMENT_DEFAULTS)
    result.update(CONFIGS[name])
    return result


def _mean(values: list):
    return statistics.mean(values) if values else None


def collect_report(report_dir: Path) -> dict:
    """Структурированные метрики из details.jsonl, без разбора Markdown."""
    details = [json.loads(line) for line in (report_dir / "details.jsonl").read_text(encoding="utf-8").splitlines()]
    judged = [d for d in details if d.get("kind") == "judge"]
    checks = [d for d in details if d.get("kind") == "check"]
    scores = [d.get("score") for d in judged]
    valid = [s for s in scores if s is not None]
    platform = any(d.get("mode") == "platform" for d in judged)

    if platform:
        metrics = platform_metrics(scores)
        overall = 10 * metrics["score"] if metrics["score"] is not None else None
        match = 10 * metrics["match_rate"] if metrics["match_rate"] is not None else None
        win = 10 * metrics["win_rate"] if metrics["win_rate"] is not None else None
    else:
        overall = _mean(valid)
        match = win = None

    by_type = {}
    for kind in ("dialog", "single"):
        values = [d["score"] for d in judged if d.get("type") == kind and d.get("score") is not None]
        by_type[kind] = _mean(values)

    return {
        "score": overall,
        "match_rate": match,
        "win_rate": win,
        "judged": len(valid),
        "judge_failed": sum(s is None for s in scores),
        "checks_total": len(checks),
        "checks_passed": sum(bool(d.get("ok")) for d in checks),
        "dialog": by_type["dialog"],
        "single": by_type["single"],
        "per_question": {d["id"]: d.get("score") for d in judged},
    }


def paired(reference: dict, candidate: dict) -> dict:
    """Число улучшений/ухудшений на пересечении успешно оценённых кейсов."""
    common = [qid for qid, value in reference.items()
              if value is not None and candidate.get(qid) is not None]
    better = sum(candidate[qid] > reference[qid] for qid in common)
    worse = sum(candidate[qid] < reference[qid] for qid in common)
    return {"better": better, "worse": worse, "same": len(common) - better - worse, "n": len(common)}


def run_config(name: str, args, output: Path, baseline_pred: str | None) -> dict:
    report_dir = output / name
    cmd = [sys.executable, str(ROOT / "eval" / "run_eval.py"),
           "--set", args.set, "--limit", str(args.limit), "--report-dir", str(report_dir)]
    if args.with_demo:
        cmd.append("--with-demo")
    if args.filter:
        cmd += ["--filter", args.filter]
    if args.no_judge:
        cmd.append("--no-judge")
    if baseline_pred:
        cmd += ["--baseline-pred", baseline_pred]
    elif args.baseline:
        cmd.append("--baseline")

    started = time.perf_counter()
    proc = subprocess.run(cmd, cwd=ROOT, env=config_env(name), capture_output=True, text=True,
                          timeout=args.timeout, check=False)
    (report_dir / "stdout.log").write_text(proc.stdout, encoding="utf-8")
    (report_dir / "stderr.log").write_text(proc.stderr, encoding="utf-8")
    if proc.returncode:
        raise RuntimeError(f"run_eval завершился с кодом {proc.returncode}: {proc.stderr[-1200:]}")
    result = collect_report(report_dir)
    result["elapsed_sec"] = round(time.perf_counter() - started, 1)
    result["report_dir"] = str(report_dir)
    if args.baseline and not baseline_pred and (report_dir / "baseline" / "submission.csv").is_file():
        result["baseline_pred"] = str(report_dir / "baseline" / "submission.csv")
    return result


def fmt(value) -> str:
    return "—" if value is None else f"{value:.2f}"


def write_summary(output: Path, results: dict, reference_name: str | None):
    serializable = {name: {k: v for k, v in row.items() if k != "per_question"} for name, row in results.items()}
    (output / "summary.json").write_text(json.dumps(serializable, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# Ablation: конфигурации генерации", "",
             "Баллы приведены к шкале 0–10. Δ и победы/поражения — относительно первой успешной конфигурации.", "",
             "| конфигурация | Score | Match | Win | n | сбои | проверки | диалоги | одиночные | Δ | лучше/хуже | сек |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    reference = results.get(reference_name, {}).get("per_question", {}) if reference_name else {}
    reference_score = results.get(reference_name, {}).get("score") if reference_name else None
    for name, row in results.items():
        if row.get("status") == "error":
            lines.append(f"| {name} | ОШИБКА |  |  |  |  |  |  |  |  |  | {row.get('elapsed_sec', '—')} |")
            continue
        comparison = paired(reference, row["per_question"]) if reference else {"better": 0, "worse": 0}
        delta = row["score"] - reference_score if row["score"] is not None and reference_score is not None else None
        checks = f"{row['checks_passed']}/{row['checks_total']}"
        lines.append(f"| {name} | {fmt(row['score'])} | {fmt(row['match_rate'])} | {fmt(row['win_rate'])} | "
                     f"{row['judged']} | {row['judge_failed']} | {checks} | {fmt(row['dialog'])} | {fmt(row['single'])} | "
                     f"{fmt(delta)} | {comparison['better']}/{comparison['worse']} | {row['elapsed_sec']} |")
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"\nСводка: {output / 'report.md'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--configs", default=",".join(CONFIGS), help="имена через запятую")
    ap.add_argument("--set", choices=["demo", "dev"], default="dev")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--with-demo", action="store_true")
    ap.add_argument("--filter")
    ap.add_argument("--baseline", action="store_true", help="один раз прогнать учебный бейзлайн и переиспользовать")
    ap.add_argument("--baseline-pred", help="готовый CSV учебного бейзлайна")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--timeout", type=int, default=1800, help="лимит одной конфигурации, секунд")
    ap.add_argument("--output", help="каталог сводки (по умолчанию eval/reports/ablation-<время>)")
    args = ap.parse_args()

    names = [name.strip() for name in args.configs.split(",") if name.strip()]
    unknown = [name for name in names if name not in CONFIGS]
    if unknown or not names:
        ap.error(f"Неизвестные конфигурации: {unknown}; доступны: {', '.join(CONFIGS)}")
    if args.limit < 1:
        ap.error("--limit должен быть положительным")

    output = Path(args.output) if args.output else ROOT / "eval" / "reports" / f"ablation-{time.strftime('%Y%m%d-%H%M%S')}"
    output.mkdir(parents=True, exist_ok=True)
    (output / "run.json").write_text(json.dumps({"configs": names, "set": args.set, "limit": args.limit,
                                                "with_demo": args.with_demo, "filter": args.filter},
                                               ensure_ascii=False, indent=2), encoding="utf-8")

    results = {}
    reference_name = None
    baseline_pred = args.baseline_pred
    for name in names:
        print(f"\n=== {name} ===", flush=True)
        started = time.perf_counter()
        try:
            row = run_config(name, args, output, baseline_pred)
            baseline_pred = row.pop("baseline_pred", baseline_pred)
            results[name] = row
            if reference_name is None:
                reference_name = name
            print(f"{name}: Score={fmt(row['score'])}, n={row['judged']}, "
                  f"проверки={row['checks_passed']}/{row['checks_total']}, {row['elapsed_sec']} c", flush=True)
        except Exception as exc:  # продолжаем остальные конфигурации и честно фиксируем сбой
            results[name] = {"status": "error", "error": f"{type(exc).__name__}: {exc}",
                             "elapsed_sec": round(time.perf_counter() - started, 1)}
            print(f"{name}: ОШИБКА: {exc}", file=sys.stderr, flush=True)
        write_summary(output, results, reference_name)


if __name__ == "__main__":
    main()
