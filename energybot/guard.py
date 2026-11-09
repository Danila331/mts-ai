"""Проверка ответа перед выдачей: числа только из материалов, разумная длина.

Самая дорогая ошибка для судьи — выдуманная цифра (цена, срок, процент). Модель
видит материалы и вопрос; если в ответе есть число, которого нет ни там, ни там,
это почти наверняка выдумка или вычисление, которое база запрещает (например,
итоговая стоимость). Тогда ответ один раз переписывается, а если не помогло —
предложения с такими числами вырезаются.
"""

from __future__ import annotations

import re

NUMBER = re.compile(r"\d+(?:[    ]\d{3})*(?:[.,]\d+)?")
SENTENCE = re.compile(r"(?<=[.!?])\s+")
MAX_WORDS = 110  # эталоны жюри — 25–52 слова; длиннее этого ответ стоит сжать


def numbers(text: str) -> set:
    found = set()
    for m in NUMBER.findall(text):
        value = re.sub(r"[    ]", "", m).replace(",", ".")
        if value.endswith(".0"):
            value = value[:-2]
        found.add(value)
    return found


def unknown_numbers(answer: str, *sources: str) -> list:
    """Числа ответа, которых нет в источниках. 1 и 2 не проверяются: «одна смена», «в 2 раза»."""
    allowed = set()
    for text in sources:
        allowed |= numbers(text)
    return sorted(n for n in numbers(answer) - allowed if not (n.isdigit() and int(n) <= 2))


def word_count(text: str) -> int:
    return len(text.split())


def strip_sentences(answer: str, bad: list) -> str:
    """Убирает предложения с непроверенными числами; остальное оставляет как есть."""
    keep = [s for s in SENTENCE.split(answer.strip()) if not (numbers(s) & set(bad))]
    return " ".join(keep).strip()


def repair_instruction(bad: list, too_long: bool) -> str:
    parts = ["[Служебная проверка ответа.]"]
    if bad:
        parts.append(
            f"В ответе есть числа, которых нет в МАТЕРИАЛАХ: {', '.join(bad)}. "
            "Не называй их: оставь только числа из материалов, а там, где точной цифры в материалах нет, "
            "скажи, что её покажет расчёт или уточнит специалист."
        )
    if too_long:
        parts.append("Ответ слишком длинный: сократи до 2–4 предложений, примерно 40–60 слов, сохранив главное.")
    parts.append("Сохрани стиль и смысл ответа. Выведи только исправленный ответ клиенту, без пояснений.")
    return " ".join(parts)
