"""Маскировка персональных данных и защита от длинных строк в журнале ядра (T35, LLM02).

Тела запросов ядро не пишет, но телефон, почта или имя клиента могут попасть в строку косвенно: в тексте
исключения, ответа сервера модели, разбора JSON. Это страховка на выходе — она ловит их в готовой строке, какой бы
код её ни написал. Телефоны и почту находит по виду; имя и компания не опознаются по виду, поэтому их можно
сообщить через remember().

Так же защита от «полного промпта в логе»: строка длиннее MAX_LINE обрезается. Промпт — десятки килобайт, а
осмысленная строка журнала — сотни знаков.

Только стандартная библиотека; в сабмит модуль не входит (scripts/ не собирается в zip).
"""

from __future__ import annotations

import io
import re
import threading

MASK = "***"
MAX_LINE = 4000
MAX_KNOWN = 512
MIN_KNOWN = 3

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
# Цифры с пробелами, скобками, точками и дефисами, плюс в начале. Подходит ли по числу цифр — решает _phone.
# Не прилипает к буквам и цифрам: десять цифр подряд внутри шестнадцатеричного request_id — не номер.
PHONE = re.compile(r"(?<![\w])\+?\d[\d \t().\-]{8,}\d(?![\w])")

_known: list = []
_lock = threading.Lock()


def remember(*values: str) -> None:
    """Значения, которые нельзя выводить (имя, компания из заявки). Короче трёх знаков не запоминаются:
    «ООО» стёрло бы пол-журнала."""
    with _lock:
        for value in values:
            value = (value or "").strip()
            if len(value) < MIN_KNOWN or value in _known:
                continue
            if len(_known) >= MAX_KNOWN:
                _known.pop(0)
            _known.append(value)


def forget() -> None:
    with _lock:
        _known.clear()


def _phone(match: re.Match) -> str:
    digits = sum(ch.isdigit() for ch in match.group(0))
    # 10–15 цифр — номер (E.164 не длиннее 15). Меньше: дата, версия, длительность; больше: идентификатор.
    return MASK if 10 <= digits <= 15 else match.group(0)


def mask(text: str, limit: int = MAX_LINE) -> str:
    """Текст без почты, телефонов и запомненных значений; длиннее limit знаков — обрезан (0 — не обрезать:
    для готовой строки JSON, которую обрезка сломала бы)."""
    text = EMAIL.sub(MASK, text)
    text = PHONE.sub(_phone, text)
    with _lock:
        values = list(_known)
    for value in values:
        if value in text:
            text = text.replace(value, MASK)
    if limit and len(text) > limit:
        text = text[:limit] + f"…[обрезано, {len(text) - limit} знаков]"
    return text


class MaskedStream(io.TextIOBase):
    """Обёртка над stderr: всё, что пишется, проходит через mask(). Построчно: print пишет текст и перевод строки
    отдельными вызовами, а маскировать надо целую строку."""

    def __init__(self, raw):
        self.raw = raw
        self.local = threading.local()
        self.lock = threading.Lock()

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        buf = getattr(self.local, "buf", "") + text
        *lines, rest = buf.split("\n")
        self.local.buf = rest
        if lines:
            with self.lock:
                for line in lines:
                    self.raw.write(mask(line) + "\n")
                self.raw.flush()
        return len(text)

    def flush(self) -> None:
        rest = getattr(self.local, "buf", "")
        if rest:
            self.local.buf = ""
            with self.lock:
                self.raw.write(mask(rest))
        self.raw.flush()
