"""Проверка ответа перед выдачей: числа только из материалов, разумная длина.

Самая дорогая ошибка для судьи — выдуманная цифра (цена, срок, процент). Модель
видит материалы и вопрос; если в ответе есть число, которого нет ни там, ни там,
это почти наверняка выдумка или вычисление, которое база запрещает (например,
итоговая стоимость). Тогда ответ один раз переписывается, а если не помогло —
предложения с такими числами вырезаются.
"""

from __future__ import annotations

import re
from decimal import Decimal

NUMBER = re.compile(r"\d+(?:[ \u00a0\u2009\u202f]\d{3})*(?:[.,]\d+)?")
SCALED_NUMBER = re.compile(
    rf"({NUMBER.pattern})(?:\s*([–—-])\s*({NUMBER.pattern}))?\s*"
    rf"(тыс(?:яч(?:а|и)?)?\.?|млн\.?|миллион(?:а|ов)?|млрд\.?|миллиард(?:а|ов)?)(?![а-яё])",
    re.I,
)
SENTENCE = re.compile(r"(?<=[.!?])\s+")
MAX_WORDS = 110  # эталоны жюри — 25–52 слова; длиннее этого ответ стоит сжать

# Число с единицей измерения: «30 лет», «25 000 ₽», «750 кВт». Голая проверка числа
# пропускала галлюцинации вроде «срок службы шифера 30 лет», если в материалах было
# другое число 30 (например «30 дней»). Поэтому проверяем пару число+единица.
NUM_UNIT = re.compile(
    rf"({NUMBER.pattern})(?:\s*(?:[–—-]|\bдо\b)\s*({NUMBER.pattern}))?\s*"
    r"((?:кило|мега)ватт\s*[-‐]?\s*час(?:а|ов)?\b|квт\s*[·⋅*\-]?\s*ч\b|"
    r"мвт\s*[·⋅*\-]?\s*ч\b|[а-яё%₽]+)",
    re.I,
)
DEVICE_COUNT_ROW = re.compile(
    rf"^\s*-\s*Показатель:\s*(?:приборы|сч[её]тчики)\b[^;\n]*;\s*"
    rf"Значение:\s*(?:более\s+|около\s+)?({NUMBER.pattern})(?=\s*(?:;|$))",
    re.I | re.M,
)
UNITS = {
    **dict.fromkeys(("лет", "год", "года"), "год"),
    **dict.fromkeys(("руб", "рубль", "рубля", "рублей", "₽"), "₽"),
    **dict.fromkeys(("процент", "процента", "процентов", "%"), "%"),
    **dict.fromkeys(("прибор", "прибора", "приборов", "счетчик", "счетчика", "счетчиков"), "прибор"),
    **dict.fromkeys(("день", "дня", "дней"), "день"),
    **dict.fromkeys(("месяц", "месяца", "месяцев"), "месяц"),
    **dict.fromkeys(("час", "часа", "часов"), "час"),
    **dict.fromkeys(("склад", "склада", "складов"), "склад"),
    **dict.fromkeys(("объект", "объекта", "объектов"), "объект"),
    **dict.fromkeys(("киловатт", "киловатта", "киловаттов"), "квт"),
    **dict.fromkeys(("мегаватт", "мегаватта", "мегаваттов"), "мвт"),
    **dict.fromkeys(("киловаттчас", "киловаттчаса", "киловаттчасов"), "квтч"),
    **dict.fromkeys(("мегаваттчас", "мегаваттчаса", "мегаваттчасов"), "мвтч"),
    **{unit: unit for unit in ("вт", "квт", "мвт", "квтч", "мвтч")},
}

CARDINALS = {
    value: forms.split() for value, forms in {
        0: "ноль нуля",
        1: "один одна одно одного одной",
        2: "два две двух",
        3: "три трех",
        4: "четыре четырех",
        5: "пять пяти",
        6: "шесть шести",
        7: "семь семи",
        8: "восемь восьми",
        9: "девять девяти",
        10: "десять десяти",
        11: "одиннадцать одиннадцати",
        12: "двенадцать двенадцати",
        13: "тринадцать тринадцати",
        14: "четырнадцать четырнадцати",
        15: "пятнадцать пятнадцати",
        16: "шестнадцать шестнадцати",
        17: "семнадцать семнадцати",
        18: "восемнадцать восемнадцати",
        19: "девятнадцать девятнадцати",
        20: "двадцать двадцати",
        30: "тридцать тридцати",
        40: "сорок сорока",
        50: "пятьдесят пятидесяти",
        60: "шестьдесят шестидесяти",
        70: "семьдесят семидесяти",
        80: "восемьдесят восьмидесяти",
        90: "девяносто девяноста",
        100: "сто ста",
        200: "двести двухсот",
        300: "триста трехсот",
        400: "четыреста четырехсот",
        500: "пятьсот пятисот",
        600: "шестьсот шестисот",
        700: "семьсот семисот",
        800: "восемьсот восьмисот",
        900: "девятьсот девятисот",
        1000: "тысяча тысячу тысячи тысяч",
        1000000: "миллион миллиона миллионов",
    }.items()
}
WORD_VALUES = {word: value for value, forms in CARDINALS.items() for word in forms}
WORD_NUMBER = "|".join(WORD_VALUES)
SPOKEN_QUANTITY = re.compile(
    rf"\b(?:{WORD_NUMBER})(?:[ \t]+(?:{WORD_NUMBER}))*\b"
    rf"(?=[ \t]+(?:{'|'.join(unit.replace('е', '[её]') for unit in UNITS if unit not in ('₽','%'))})\b)",
    re.I,
)
POWER_BEFORE_QUANTITY = re.compile(
    rf"\b(кВт|МВт|киловатт|мегаватт)\s+на\s+({NUMBER.pattern})(?=\s*(?:[.,!?;]|$))",
    re.I,
)


def normalize_user_quantities(text: str) -> str:
    """Восстанавливает цифры для явно названных клиентом количеств с единицей."""
    def render(match):
        raw = match.group()
        values = [WORD_VALUES[word] for word in raw.lower().replace("ё", "е").split()]
        total = group = 0
        previous = scale = float("inf")
        for value in values:
            if value >= 1000:
                if value >= scale or (not group and total):
                    return raw
                total += (group or 1) * value
                group, previous, scale = 0, float("inf"), value
            else:
                if value >= previous or previous < 20 or (previous < 100 and value >= 10):
                    return raw
                group += value
                previous = value
        return str(total + group)

    normalized = SPOKEN_QUANTITY.sub(render, text.replace("ё", "е").replace("Ё", "Е"))
    return POWER_BEFORE_QUANTITY.sub(lambda match: f"{match.group(2)} {match.group(1)}", normalized)


def _number_value(value: str) -> str:
    normalized = "".join(value.split()).replace(",", ".")
    return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized


def _expand_scales(text: str) -> str:
    def expand(match):
        scale = match.group(4).lower()
        multiplier = 1000 if scale.startswith("тыс") else 1000000 if scale.startswith(("млн", "миллион")) else 1000000000
        first = format(Decimal(_number_value(match.group(1))) * multiplier, "f")
        if match.group(3):
            second = format(Decimal(_number_value(match.group(3))) * multiplier, "f")
            return first + match.group(2) + second
        return first

    return SCALED_NUMBER.sub(expand, text)


def _unit_pairs(text: str) -> set:
    """Пары (число, единица), включая обе границы диапазонов."""
    pairs = set()
    for first, second, unit in NUM_UNIT.findall(_expand_scales(text)):
        unit = re.sub(r"[\s·⋅*\-‐]", "", unit.lower().replace("ё", "е"))
        if unit in UNITS:
            pairs.add((_number_value(first), UNITS[unit]))
            if second:
                pairs.add((_number_value(second), UNITS[unit]))
    return pairs


def numbers(text: str) -> set:
    return {_number_value(value) for value in NUMBER.findall(_expand_scales(text))}


def unknown_numbers(answer: str, *sources: str) -> list:
    """Числа ответа, которых нет в источниках.

    Если после числа стоит единица из UNITS, требуем совпадения пары «число + единица»:
    «25 лет» не подтверждается материалом «25 000 ₽».
    """
    allowed = set()
    allowed_pairs = set()
    for text in sources:
        allowed |= numbers(text)
        allowed_pairs |= _unit_pairs(text)
        allowed_pairs.update((_number_value(value), "прибор") for value in DEVICE_COUNT_ROW.findall(text))
    bad = (numbers(answer) - allowed) - {"0", "1", "2"}
    mismatched = sorted(
        f"{value} {unit}"
        for value, unit in _unit_pairs(answer) - allowed_pairs
        if value not in bad and (value not in {"0", "1", "2"} or unit in {"вт", "квт", "мвт", "квтч", "мвтч", "₽", "%"})
    )
    return sorted(bad) + mismatched


def word_count(text: str) -> int:
    return len(text.split())


def strip_sentences(answer: str, bad: list) -> str:
    """Убирает предложения с непроверенными числами и парами «число, единица»."""
    bare = {value for value in bad if " " not in value}
    pairs = {tuple(value.split(" ", 1)) for value in bad if " " in value}
    keep = [s for s in SENTENCE.split(answer.strip()) if not (numbers(s) & bare or _unit_pairs(s) & pairs)]
    return " ".join(keep).strip()


def repair_instruction(bad: list, too_long: bool, not_direct: bool = False) -> str:
    parts = ["[Служебная проверка ответа.]"]
    if bad:
        parts.append(
            f"В ответе есть числа, которых нет в МАТЕРИАЛАХ: {', '.join(bad)}. "
            "Не называй их: оставь только числа из материалов, а там, где точной цифры в материалах нет, "
            "скажи, что её покажет расчёт или уточнит специалист."
        )
    if too_long:
        parts.append("Ответ слишком длинный: сократи до 2–4 предложений, примерно 40–60 слов, сохранив главное.")
    if not_direct:
        parts.append("Вопрос клиента предполагает «да/нет»: начни с прямого ответа («Да, …», «Нет, …», «Пока нет: …»), затем факт из материалов.")
    parts.append("Сохрани стиль и смысл ответа. Выведи только исправленный ответ клиенту, без пояснений.")
    return " ".join(parts)
