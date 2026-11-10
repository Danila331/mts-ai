"""Подготовка и объединение длинных прогонов run_eval по непрерывным частям."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FALLBACK_MARK = "в моих материалах нет, поэтому не буду гадать"


def read(path: Path) -> dict:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return {row["id"]: row["answer"] for row in csv.DictReader(f)}


def write(path: Path, answers: dict, order: list):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writerow(["id", "answer"])
        writer.writerows((qid, answers.get(qid, "")) for qid in order)


def prepare(partial: Path, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    answers = read(partial)
    missing = {qid for qid, answer in answers.items() if FALLBACK_MARK in answer}
    cases = [json.loads(line) for line in (ROOT / "eval" / "dataset" / "cases.jsonl").read_text(encoding="utf-8").splitlines()]
    remaining = [case for case in cases if case.get("split") == "dev" and case["id"] in missing]
    with (output / "remaining-dev.jsonl").open("w", encoding="utf-8") as f:
        for case in remaining:
            f.write(json.dumps(case, ensure_ascii=False) + "\n")
    with (ROOT / "demo_questions.csv").open(encoding="utf-8-sig", newline="") as src, \
            (output / "remaining-demo.csv").open("w", encoding="utf-8", newline="") as dst:
        reader = csv.DictReader(src)
        writer = csv.DictWriter(dst, fieldnames=reader.fieldnames, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writeheader()
        demo_count = 0
        for row in reader:
            if f"demo-{row['id'].strip()}" in missing:
                writer.writerow(row)
                demo_count += 1
    print(f"Осталось: dev={len(remaining)}, demo={demo_count}")


def merge(partial: Path, output: Path, chunks: list):
    answers = read(partial)
    baseline = {}
    order = list(answers)
    for chunk in chunks:
        answers.update(read(chunk / "predictions.csv"))
        baseline_path = chunk / "baseline" / "submission.csv"
        if baseline_path.is_file():
            baseline.update(read(baseline_path))
    output.mkdir(parents=True, exist_ok=True)
    write(output / "bot.csv", answers, order)
    if baseline:
        write(output / "baseline.csv", baseline, order)
    incomplete = sum(FALLBACK_MARK in answers.get(qid, "") for qid in order)
    print(f"Объединено: {len(order)}; начальных заглушек осталось: {incomplete}; бейзлайн: {len(baseline)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "merge"):
        cmd = sub.add_parser(name)
        cmd.add_argument("partial", type=Path)
        cmd.add_argument("output", type=Path)
        if name == "merge":
            cmd.add_argument("chunks", type=Path, nargs="+")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.partial, args.output)
    else:
        merge(args.partial, args.output, args.chunks)


if __name__ == "__main__":
    main()
