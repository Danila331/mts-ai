"""Детерминированная проверка уточняющих вопросов против эталонов жюри на демо.

Для 13 эталонов с вопросом проверяем, что у бота есть вопрос и его тема совпадает
с эталонной. Для 5 эталонов без вопроса — что бот не задаёт лишнего.

    python eval/question_eval.py eval/reports/<время>/predictions.csv
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Тема вопроса эталона (по demo_output.csv): регекс по формулировке.
EXPECTED = {
    "demo-1": r"регион",
    "demo-2": r"регион",
    "demo-3": r"дневн|потреблен",
    "demo-4": r"кровл|лет|возраст",
    "demo-5": r"модел|сч[её]тчик|прибор",
    "demo-6": r"цех|сч[её]тчик",
    "demo-7": r"магазин|показан",
    "demo-10": r"категори",
    "demo-12": r"мощност",
    "demo-14": r"дн[её]м|вечер",
    "demo-15": r"техник|сч[её]тчик",
    "demo-17": r"мощност|месяц",
    "demo-18": r"сбор|вручную|снима|удал[её]н",
}
NO_QUESTION = {"demo-8", "demo-9", "demo-11", "demo-13", "demo-16"}

# Обязательная открывашка эталона (первая строка ответа жюри), дословно.
OPENINGS = {
    "demo-1": "Да", "demo-2": "Да", "demo-3": "Да", "demo-4": "Старую", "demo-5": "Нет",
    "demo-6": "Да", "demo-7": "Да", "demo-8": "Да", "demo-9": "Да", "demo-10": "Да",
    "demo-11": "Да", "demo-12": "Да", "demo-13": "Да", "demo-14": "Может", "demo-15": "Начать",
    "demo-16": "Да", "demo-17": "Для", "demo-18": "Конечно",
}


def main(path: str):
    answers = {r["id"]: r["answer"] for r in csv.DictReader(open(path, encoding="utf-8-sig"))}
    hit = miss = extra = ok_none = 0
    for qid, pattern in EXPECTED.items():
        a = answers.get(qid, "")
        parts = [p for p in a.split("?") if p.strip()]
        has_q = a.rstrip().endswith("?")
        topic_ok = bool(re.search(pattern, a, re.I))
        if has_q and topic_ok:
            hit += 1
        else:
            miss += 1
            print(f"✗ {qid}: вопрос={'да' if has_q else 'нет'}, тема {'совпала' if topic_ok else 'мимо'}"
                  f" | хвост: …{a[-90:]}")
    for qid in NO_QUESTION:
        if answers.get(qid, "").rstrip().endswith("?"):
            extra += 1
            print(f"✗ {qid}: лишний вопрос | …{answers[qid][-90:]}")
        else:
            ok_none += 1
    total = len(EXPECTED) + len(NO_QUESTION)
    print(f"\nтема вопроса совпала: {hit}/{len(EXPECTED)}; без лишних вопросов: {ok_none}/{len(NO_QUESTION)}; "
          f"итого: {hit + ok_none}/{total}")
    # Открывашки против эталона (первая строка)
    op_ok = 0
    for qid, opening in OPENINGS.items():
        a = answers.get(qid, "").strip()
        if a.split()[0].rstrip(",.") == opening if a else False:
            op_ok += 1
        else:
            print(f"✗ {qid}: открывашка «{a.split()[0] if a else '—'}» вместо «{opening}»")
    print(f"открывашки совпали: {op_ok}/{len(OPENINGS)}")


if __name__ == "__main__":
    main(sys.argv[1])
