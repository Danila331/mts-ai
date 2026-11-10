"""Точка входа для автоматической проверки МТС EnergyTool.

Читает DATA_DIR/questions.csv (id,question) и базу знаний, пишет submission.csv (id,answer).
Каждый вопрос обрабатывается независимо; диалог приходит одной строкой.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

# Вариант v28 — схема v3 с правилами «как у жюри» (eval/VARIANTS.md). Умолчание: EB_STYLE из окружения главнее.
os.environ.setdefault("EB_STYLE", "jury")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.llm import Api, env, env_num  # noqa: E402
from energybot.pipeline import FALLBACK, Consultant  # noqa: E402

DATA_DIR = Path(env("DATA_DIR", "data"))
OUTPUT = Path(env("OUTPUT_PATH", "submission.csv"))
# MAX_WORKERS платформы отражает лимиты сервиса (регламент, раздел 6) — уважаем его.
MAX_WORKERS = env_num("EB_MAX_WORKERS", 0, 0, 16) or env_num("MAX_WORKERS", 4, 1, 16)
# Лимит прогона на платформе — 20 минут. С 17-й минуты новых запросов к модели нет: необработанные вопросы
# получают выдержку из базы, остаётся запас на запись файла.
DEADLINE_SEC = env_num("EB_DEADLINE_SEC", 1020.0, 5.0, 3600.0, float)
# Жёсткий предел: к этому моменту файл записан при любом поведении сети, зависшие потоки бросаются.
HARD_DEADLINE_SEC = env_num("EB_HARD_DEADLINE_SEC", 1140.0, 10.0, 3600.0, float)
MAX_ANSWER_CHARS = 9000  # предел платформы — 10 000 символов
FLUSH_EVERY_SEC = 5.0  # как часто дописывать готовые ответы в submission.csv
OFFLINE_MARGIN_SEC = 20.0  # верхняя граница запаса до дедлайна, после которого модель уже не вызываем


# Оценки длительности одного вопроса, пока нет своих замеров.
EXTRA_PRIOR_SEC = 15.0
PLAIN_PRIOR_SEC = 5.0


class Budget:
    """Распределяет время прогона между вопросами.

    Режимы по убыванию качества: extra (с дорогими шагами — опорой из базы или размышлениями) →
    normal → fast (без реранкера, повторной генерации и с сокращённым контекстом) → offline (без модели).

    Дорогие шаги дают лучший ответ, но удлиняют его в разы, поэтому вопрос получает их, только если
    после него все оставшиеся вопросы гарантированно успевают в обычном режиме. Так они достаются
    стольким вопросам, сколько позволяет запас времени, а прогон не выходит за дедлайн.
    Если и обычный режим не успевает — включается быстрый и не выключается. Когда до дедлайна
    остаётся меньше, чем нужно на один ответ (1,5 средней длительности, от 5 до OFFLINE_MARGIN_SEC
    секунд), модель больше не вызывается.
    """

    def __init__(self, total: int, started: float, deadline_sec: float, workers: int, extra: bool = False):
        self.total, self.started, self.deadline_sec, self.workers = total, started, deadline_sec, workers
        self.extra = extra
        self.lock = threading.Lock()
        self.dispatched = self.done = 0
        self.stats = {"extra": [0, 0.0], "plain": [0, 0.0]}  # режим → [вопросов, секунд]
        self.fast = False
        self.fast_from = None

    def _plain_avg(self) -> float:
        n, sec = self.stats["plain"]
        if n:
            return sec / n
        n, sec = self.stats["extra"]
        # Своих замеров обычного режима ещё нет: берём долю от длительности с дорогими шагами.
        return max(PLAIN_PRIOR_SEC, 0.35 * sec / n) if n else PLAIN_PRIOR_SEC

    def _extra_avg(self) -> float:
        n, sec = self.stats["extra"]
        return sec / n if n else max(EXTRA_PRIOR_SEC, 3 * self._plain_avg())

    def take(self) -> str:
        with self.lock:
            self.dispatched += 1
            left = self.deadline_sec - (time.perf_counter() - self.started)
            plain = self._plain_avg()
            cap = min(OFFLINE_MARGIN_SEC, 0.2 * self.deadline_sec)  # запас не больше пятой части дедлайна
            margin = cap if not self.done else min(cap, max(min(5.0, cap), 1.5 * plain))
            if left < margin:
                return "offline"
            remaining = self.total - self.dispatched + 1
            # Быстрый режим включается только по собственным замерам обычного режима: оценка «доля от
            # длительности с дорогими шагами» слишком грубая, чтобы из-за неё необратимо резать качество.
            if not self.fast and self.stats["plain"][0] >= self.workers:
                projected = remaining * plain / self.workers
                if projected > 0.85 * left:
                    self.fast, self.fast_from = True, self.dispatched
                    print(f"[budget] не успеваем: осталось {remaining} вопросов, прогноз {projected:.0f} c "
                          f"при {left:.0f} c — быстрый режим", file=sys.stderr, flush=True)
            if self.fast:
                return "fast"
            if self.extra:
                # Остальные вопросы в обычном режиме + этот с дорогими шагами (с запасом на долгий ответ).
                need = (remaining - 1) * plain / self.workers + 1.5 * self._extra_avg()
                if need <= 0.8 * left:
                    return "extra"
            return "normal"

    def record(self, seconds: float, mode: str = "normal"):
        with self.lock:
            self.done += 1
            stat = self.stats["extra" if mode == "extra" else "plain"]
            stat[0] += 1
            stat[1] += seconds


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
        # ID сохраняется ровно как во входном файле: регламент требует ответ на каждый исходный ID.
        return [(str(row[id_col]), str(row[q_col] or "")) for row in reader]


def write_answers(path: Path, rows: list):
    """Атомарно: пишем во временный файл рядом и подменяем — платформа никогда не увидит файл наполовину."""
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writerow(["id", "answer"])
        for qid, answer in rows:
            text = " ".join(answer.split())[:MAX_ANSWER_CHARS] or FALLBACK
            writer.writerow([qid, text])
    os.replace(tmp, path)


def main():
    started = time.perf_counter()
    questions = read_questions(find("questions.csv", "train.csv", "test.csv", "demo_questions.csv"))
    kb_path = find("knowledge-base.zip", "knowledge_base.zip", "kb.zip", "knowledge-base")
    answers = [FALLBACK] * len(questions)
    # Файл с запасными ответами пишем сразу: даже при падении сабмит будет валидным.
    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])

    api = Api()
    api.deadline = started + DEADLINE_SEC
    turns = [parse(q) for _, q in questions]

    # Загрузка базы и эмбеддинги — тоже под жёстким дедлайном. Тайм-аут httpx ограничивает паузы между
    # порциями данных, а не весь запрос, и медленно «капающий» ответ /embeddings держал бы главный поток
    # дольше лимита платформы (регламент, раздел 5) ещё до того, как ниже включается ожидание с дедлайном.
    # Не успели — в файле уже запасные ответы, выходим, не дожидаясь зависшего запроса.
    prepared: dict = {}

    def prepare():
        try:
            prepared["bot"] = Consultant(kb_path, index_dir=HERE / "index", api=api)
            prepared["vectors"] = prepared["bot"].embed_queries([search_queries(t)[1] for t in turns])
        except BaseException as exc:  # noqa: BLE001 — ошибку поднимет главный поток
            prepared["error"] = exc

    loader = threading.Thread(target=prepare, daemon=True)
    loader.start()
    loader.join(timeout=max(1.0, HARD_DEADLINE_SEC - (time.perf_counter() - started)))
    if "error" in prepared:
        raise prepared["error"]
    if "vectors" not in prepared:
        print("Подготовка не уложилась в жёсткий дедлайн — в файле запасные ответы", file=sys.stderr, flush=True)
        sys.stdout.flush()
        os._exit(0)
    bot, vectors = prepared["bot"], prepared["vectors"]
    print(f"Вопросов: {len(questions)}; потоков: {MAX_WORKERS}", file=sys.stderr, flush=True)

    debug_path = env("DEBUG_JSONL")
    debug = []
    budget = Budget(len(questions), started, DEADLINE_SEC, MAX_WORKERS, extra=bot.has_extra)
    saved = threading.Lock()
    last_flush = [time.perf_counter()]
    closed = threading.Event()  # итог собирает главный поток: поздние ответы зависших потоков не пишем

    def keep(i: int, text: str):
        """Готовый ответ сразу попадает в submission.csv (не чаще раза в FLUSH_EVERY_SEC): если процесс убьют,
        в файле останутся все ответы, полученные к этому моменту."""
        with saved:
            if closed.is_set():
                return
            answers[i] = text
            if time.perf_counter() - last_flush[0] >= FLUSH_EVERY_SEC:
                write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])
                last_flush[0] = time.perf_counter()

    def work(i):
        qid = questions[i][0]
        mode = budget.take()
        t0 = time.perf_counter()
        try:
            result = bot.answer(turns[i], mode="eval", query_vec=vectors[i], fast=mode == "fast",
                                offline=mode == "offline", premium=mode == "extra")
        except Exception as exc:  # noqa: BLE001
            print(f"[{qid}] {type(exc).__name__}: {exc}", file=sys.stderr)
            return qid, FALLBACK, {"id": qid, "error": str(exc), "mode": mode}
        finally:
            if mode != "offline":
                budget.record(time.perf_counter() - t0, mode)
        info = {"id": qid, "mode": mode, "sources": result.sources, "timings": result.timings,
                "error": result.error, "guard": result.guard}
        print(f"[{qid}] {mode} {result.timings.get('total', 0):.1f} c"
              f"{' guard=' + ','.join(result.guard) if result.guard else ''}", file=sys.stderr, flush=True)
        keep(i, result.text)
        return qid, result.text, info

    pool = ThreadPoolExecutor(max_workers=MAX_WORKERS)
    futures = {pool.submit(work, i): i for i in range(len(questions))}
    done, pending = wait(futures, timeout=max(1.0, HARD_DEADLINE_SEC - (time.perf_counter() - started)))
    with saved:
        closed.set()  # с этого момента answers и файл меняет только главный поток
        for future in done:
            _qid, text, info = future.result()
            answers[futures[future]] = text
            debug.append(info)
    # Тайм-аут httpx ограничивает паузы между порциями данных, а не весь запрос: медленно
    # «капающий» ответ мог бы держать поток за дедлайном. Такие вопросы отвечаем без модели.
    for future in pending:
        i = futures[future]
        try:
            answers[i] = bot.answer(turns[i], mode="eval", offline=True).text
        except Exception:  # noqa: BLE001
            answers[i] = FALLBACK
        debug.append({"id": questions[i][0], "mode": "hard-deadline"})
    pool.shutdown(wait=False, cancel_futures=True)

    write_answers(OUTPUT, [(qid, a) for (qid, _), a in zip(questions, answers)])
    if debug_path:
        with open(debug_path, "w", encoding="utf-8") as f:
            for row in debug:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    fails = sum(1 for a in answers if a == FALLBACK)
    modes = {m: sum(1 for d in debug if d.get("mode") == m) for m in ("extra", "normal", "fast", "offline")}
    guarded = sum(1 for d in debug if d.get("guard"))
    hard = len(pending)
    print(f"Готово: {OUTPUT} ({len(questions)} ответов, запасных: {fails}, режимы: {modes}, "
          f"исправлено проверкой: {guarded}{f', жёсткий дедлайн: {hard}' if hard else ''}) "
          f"за {time.perf_counter() - started:.0f} c", file=sys.stderr, flush=True)
    if hard:
        # Не ждём зависшие потоки: файл уже записан.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
