"""Проверка бюджета времени без доступа к модели.

1. Расчётная таблица: сколько вопросов решение успевает за EB_DEADLINE_SEC при разной
   скорости модели и разном MAX_WORKERS платформы (обычный и быстрый режим).
2. Симуляция: solution.py прогоняется на заглушке API с заданными задержками — видно,
   включается ли быстрый режим, сколько ответов ушло без модели и уложились ли в срок.

    python scripts/simulate_budget.py --questions 300 --chat-delay 1.0 --workers 4 --deadline 60
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))

from mock_api import MockApi  # noqa: E402

DEADLINE_PLATFORM = 1050  # EB_DEADLINE_SEC по умолчанию при тайм-ауте платформы 20 минут
OFFLINE_MARGIN = 20


def table():
    print(f"Сколько вопросов успеваем за {DEADLINE_PLATFORM} c (обычный режим / быстрый режим):")
    print("  задержка ответа модели →   3 c          5 c          8 c          12 c")
    for workers in (1, 2, 4, 8):
        cells = []
        for chat in (3, 5, 8, 12):
            usable = DEADLINE_PLATFORM - OFFLINE_MARGIN
            normal = int(usable * workers / (chat * 1.1 + 0.7))  # +реранкер, +~10% повторов проверки
            fast = int(usable * workers / chat)
            cells.append(f"{normal:5d} / {fast:<5d}")
        print(f"  MAX_WORKERS={workers}:        " + "  ".join(cells))
    print("  (вопросы сверх этого не теряются: последние получают выдержку из базы без модели)\n")


def simulate(args):
    cases = [json.loads(l) for l in (ROOT / "eval/dataset/cases.jsonl").read_text(encoding="utf-8").splitlines()]
    questions = [(str(i), cases[i % len(cases)]["question"]) for i in range(args.questions)]
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp) / "data"
        data.mkdir()
        with open(data / "questions.csv", "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, quoting=csv.QUOTE_ALL)
            w.writerow(["id", "question"])
            w.writerows(questions)
        with zipfile.ZipFile(data / "knowledge-base.zip", "w") as z:
            for p in (ROOT / "knowledge-base").rglob("*.md"):
                z.write(p, p.relative_to(ROOT / "knowledge-base").as_posix())
        with MockApi(reject_template_kwargs=False, chat_delay=args.chat_delay,
                     rerank_delay=args.rerank_delay, embed_delay=0.05) as mock:
            env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "OPENAI_", "EB_"))}
            env.update(DATA_DIR=str(data), LLM_BASE_URL=mock.url, LLM_API_KEY="test-key",
                       MAX_WORKERS=str(args.workers), EB_DEADLINE_SEC=str(args.deadline))
            t0 = time.perf_counter()
            proc = subprocess.run([sys.executable, str(ROOT / "solution.py")], cwd=tmp, env=env,
                                  capture_output=True, text=True)
            elapsed = time.perf_counter() - t0
            with open(Path(tmp) / "submission.csv", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
    summary = [l for l in proc.stderr.splitlines() if l.startswith(("Готово", "[budget]"))]
    print(f"Симуляция: {args.questions} вопросов, ответ модели {args.chat_delay} c, реранкер {args.rerank_delay} c, "
          f"MAX_WORKERS={args.workers}, дедлайн {args.deadline} c")
    for line in summary:
        print("  " + line)
    empty = sum(1 for r in rows if not r["answer"].strip())
    print(f"  итого {elapsed:.0f} c из {args.deadline} c; строк в submission.csv: {len(rows)}, пустых: {empty}; "
          f"код выхода {proc.returncode}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", type=int, default=200)
    ap.add_argument("--chat-delay", type=float, default=0.5)
    ap.add_argument("--rerank-delay", type=float, default=0.2)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--deadline", type=float, default=60)
    ap.add_argument("--table-only", action="store_true")
    args = ap.parse_args()
    table()
    if not args.table_only:
        simulate(args)


if __name__ == "__main__":
    main()
