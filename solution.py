"""Точка входа для автоматической проверки МТС EnergyTool.

Читает DATA_DIR/questions.csv (id,question) и базу знаний, пишет submission.csv (id,answer).
Каждый вопрос обрабатывается независимо; диалог приходит одной строкой.
"""

from __future__ import annotations

import csv
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.llm import Api, env, env_num  # noqa: E402
from energybot.pipeline import FALLBACK, Consultant  # noqa: E402

DATA_DIR = Path(env("DATA_DIR", "data"))
OUTPUT = Path(env("OUTPUT_PATH", "submission.csv"))
# MAX_WORKERS платформы отражает лимиты сервиса (регламент, раздел 6) — уважаем его.
MAX_WORKERS = env_num("EB_MAX_WORKERS", 0, 0, 16) or env_num("MAX_WORKERS", 4, 1, 16)
# Лимит прогона на платформе — 20 минут; оставляем запас на запись файла.
DEADLINE_SEC = env_num("EB_DEADLINE_SEC", 1050.0, 30.0, 3600.0, float)
MAX_ANSWER_CHARS = 9000  # предел платформы — 10 000 символов
OFFLINE_MARGIN_SEC = 20.0  # верхняя граница запаса до дедлайна, после которого модель уже не вызываем


class Budget:
    """Следит, успеваем ли ответить на все вопросы до дедлайна.

    По средней длительности уже обработанных вопросов прогнозирует, хватит ли времени на
    оставшиеся. Если нет — включает быстрый режим (без реранкера и повторной генерации)
    и не выключает его. Когда до дедлайна остаётся меньше, чем нужно на один ответ
    (1,5 средней длительности, от 5 до OFFLINE_MARGIN_SEC секунд), модель больше не вызывается.
    """

    def __init__(self, total: int, started: float, deadline_sec: float, workers: int):
        self.total, self.started, self.deadline_sec, self.workers = total, started, deadline_sec, workers
        self.lock = threading.Lock()
        self.dispatched = self.done = 0
        self.spent = 0.0
        self.fast = False
        self.fast_from = None

    def take(self) -> str:
        with self.lock:
            self.dispatched += 1
            left = self.deadline_sec - (time.perf_counter() - self.started)
            avg = self.spent / self.done if self.done else None
            margin = OFFLINE_MARGIN_SEC if avg is None else min(OFFLINE_MARGIN_SEC, max(5.0, 1.5 * avg))
            if left < margin:
                return "offline"
            if not self.fast and self.done >= self.workers:
                remaining = self.total - self.dispatched + 1
                projected = remaining * avg / self.workers
                if projected > 0.85 * left:
                    self.fast, self.fast_from = True, self.dispatched
                    print(f"[budget] не успеваем: осталось {remaining} вопросов, прогноз {projected:.0f} c "
                          f"при {left:.0f} c — быстрый режим", file=sys.stderr, flush=True)
            return "fast" if self.fast else "normal"

    def record(self, seconds: float):
        with self.lock:
            self.done += 1
            self.spent += seconds


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
            text = " ".join(answer.split())[:MAX_ANSWER_CHARS] or FALLBACK
            writer.writerow([qid, text])


def main():
    started = time.perf_counter()
    questions = read_questions(find("questions.csv", "train.csv", "test.csv", "demo_questions.csv"))
    kb_path = find("knowledge-base.zip", "knowledge_base.zip", "kb.zip", "knowledge-base")
    answers = [FALLBACK] * len(questions)
    # Файл с запасными ответами пишем сразу: даже при падении сабмит будет валидным.
    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])

    api = Api()
    api.deadline = started + DEADLINE_SEC
    bot = Consultant(kb_path, index_dir=HERE / "index", api=api)
    turns = [parse(q) for _, q in questions]
    vectors = bot.embed_queries([search_queries(t)[1] for t in turns])
    print(f"Вопросов: {len(questions)}; потоков: {MAX_WORKERS}", file=sys.stderr, flush=True)

    debug_path = env("DEBUG_JSONL")
    debug = []
    budget = Budget(len(questions), started, DEADLINE_SEC, MAX_WORKERS)

    def work(i):
        qid = questions[i][0]
        mode = budget.take()
        t0 = time.perf_counter()
        try:
            result = bot.answer(turns[i], mode="eval", query_vec=vectors[i],
                                fast=mode == "fast", offline=mode == "offline")
        except Exception as exc:  # noqa: BLE001
            print(f"[{qid}] {type(exc).__name__}: {exc}", file=sys.stderr)
            return qid, FALLBACK, {"id": qid, "error": str(exc), "mode": mode}
        finally:
            if mode != "offline":
                budget.record(time.perf_counter() - t0)
        info = {"id": qid, "mode": mode, "sources": result.sources, "timings": result.timings,
                "error": result.error, "guard": result.guard}
        print(f"[{qid}] {mode} {result.timings.get('total', 0):.1f} c"
              f"{' guard=' + ','.join(result.guard) if result.guard else ''}", file=sys.stderr, flush=True)
        return qid, result.text, info

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for i, (_qid, text, info) in enumerate(pool.map(work, range(len(questions)))):
            answers[i] = text
            debug.append(info)

    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])
    if debug_path:
        with open(debug_path, "w", encoding="utf-8") as f:
            for row in debug:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    fails = sum(1 for a in answers if a == FALLBACK)
    modes = {m: sum(1 for d in debug if d.get("mode") == m) for m in ("normal", "fast", "offline")}
    guarded = sum(1 for d in debug if d.get("guard"))
    print(f"Готово: {OUTPUT} ({len(questions)} ответов, запасных: {fails}, режимы: {modes}, "
          f"исправлено проверкой: {guarded}) за {time.perf_counter() - started:.0f} c", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
