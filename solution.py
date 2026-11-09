"""Точка входа для автоматической проверки МТС EnergyTool.

Читает DATA_DIR/questions.csv (id,question) и базу знаний, пишет submission.csv (id,answer).
Каждый вопрос обрабатывается независимо; диалог приходит одной строкой.
"""

from __future__ import annotations

import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.llm import env, env_num  # noqa: E402
from energybot.pipeline import FALLBACK, Consultant  # noqa: E402

DATA_DIR = Path(env("DATA_DIR", "data"))
OUTPUT = Path(env("OUTPUT_PATH", "submission.csv"))
MAX_WORKERS = env_num("MAX_WORKERS", 4, 1, 16)


def find(*names) -> Path:
    roots = [DATA_DIR, HERE / DATA_DIR, Path.cwd(), HERE]
    for root in roots:
        for name in names:
            path = root / name
            if path.exists():
                return path
    raise FileNotFoundError(f"Не найдено ни одного из: {names} (DATA_DIR={DATA_DIR})")


def read_questions(path: Path) -> list:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fields = {name.strip().lower(): name for name in reader.fieldnames or []}
        id_col, q_col = fields.get("id", "id"), fields.get("question", "question")
        return [(str(row[id_col]).strip(), str(row[q_col] or "")) for row in reader]


def write_answers(path: Path, rows: list):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writerow(["id", "answer"])
        for qid, answer in rows:
            writer.writerow([qid, " ".join(answer.split())])


def main():
    started = time.perf_counter()
    questions = read_questions(find("questions.csv", "train.csv", "test.csv", "demo_questions.csv"))
    kb_path = find("knowledge-base.zip", "knowledge_base.zip", "kb.zip", "knowledge-base")
    answers = [FALLBACK] * len(questions)
    # Файл с запасными ответами пишем сразу: даже при падении сабмит будет валидным.
    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])

    bot = Consultant(kb_path, index_dir=HERE / "index")
    turns = [parse(q) for _, q in questions]
    vectors = bot.embed_queries([search_queries(t)[1] for t in turns])
    print(f"Вопросов: {len(questions)}; потоков: {MAX_WORKERS}", file=sys.stderr, flush=True)

    debug_path = env("DEBUG_JSONL")
    debug = []

    def work(i):
        qid = questions[i][0]
        try:
            result = bot.answer(turns[i], mode="eval", query_vec=vectors[i])
        except Exception as exc:  # noqa: BLE001
            print(f"[{qid}] {type(exc).__name__}: {exc}", file=sys.stderr)
            return qid, FALLBACK, {"error": str(exc)}
        info = {"id": qid, "sources": result.sources, "timings": result.timings, "error": result.error}
        print(f"[{qid}] {result.timings.get('total', 0):.1f} c", file=sys.stderr, flush=True)
        return qid, result.text, info

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for i, (qid, text, info) in enumerate(pool.map(work, range(len(questions)))):
            answers[i] = text
            debug.append(info)

    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])
    if debug_path:
        with open(debug_path, "w", encoding="utf-8") as f:
            for row in debug:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    fails = sum(1 for a in answers if a == FALLBACK)
    print(f"Готово: {OUTPUT} ({len(questions)} ответов, запасных: {fails}) "
          f"за {time.perf_counter() - started:.0f} c", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
