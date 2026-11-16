"""Кнопки быстрых ответов (T31): варианты ответа клиента на уточняющий вопрос бота.

Без модели и без сети: детерминированные правила по тексту вопроса и паспорту задачи. Одинаковый ответ
и паспорт дают одинаковые кнопки; новых фактов о продуктах здесь нет — варианты это реплики клиента о себе
(«Не знаю», «Приборов пока нет»), а закрытый список задач совпадает с полем «Задача» паспорта
(backend/internal/passport: Tasks; в базе — раздел «Какие сведения могут понадобиться»).

Только режим chat (scripts/core_api.py): автопроверка (solution.py) и копилот этот модуль не вызывают.
Кнопки не блокируют поле ввода: клиент отвечает как ему удобно, кнопка лишь подставляет готовую реплику.
"""

from __future__ import annotations

import re

MIN_OPTIONS = 2
MAX_OPTIONS = 4

DONT_KNOW = "Не знаю"
# Закрытый список поля «Задача» паспорта (backend/internal/passport: Tasks) — формулировки клиента.
TASKS = ("Снизить платёж", "Автоматизировать учёт", "Найти потери", "Повысить надёжность электроснабжения")
TASK_VALUES = {  # значение поля паспорта → кнопка
    "снижение платежа": TASKS[0],
    "автоматизация учёта": TASKS[1],
    "поиск потерь": TASKS[2],
    "надёжность электроснабжения": TASKS[3],
}

SENTENCE = re.compile(r"(?<=[.!?…])\s+")
YES_NO = re.compile(r"^(?:есть ли|имеется ли|используете ли|используется ли|планируете ли|подключены ли|нужно ли|"
                    r"хотите ли|хотели бы ли|готовы ли|ведёте ли|ведется ли|ведётся ли|установлены ли|"
                    r"уже ли|можно ли|подходит ли|интересует ли)\b", re.I)
HANDOFF = re.compile(r"передать (?:ваш )?(?:запрос|заявку|вопрос)|оформить заявку|передам запрос|"
                     r"подключить менеджера|связать(?:ся)? с менеджером", re.I)
# (шаблон вопроса, варианты ответа) — первое совпавшее правило. Варианты — реплики клиента, без фактов о продуктах.
RULES = (
    (re.compile(r"какая (?:у вас |ваша )?задача|какую задачу|что (?:вы )?хотите|что для вас важнее|цель|"
                r"чего (?:вы )?хотите", re.I), "task"),
    (re.compile(r"сбор(?:а|у|ом)? показаний|как (?:вы )?(?:сейчас )?(?:собираете|снимаете)|"
                r"схем[аеуы] (?:сбора|учёта)", re.I),
     ("Снимаем показания вручную", "Уже есть автоматический сбор", DONT_KNOW)),
    (re.compile(r"прибор|счётчик|счетчик", re.I), "meters"),
    (re.compile(r"мощност", re.I), ("Назову позже", DONT_KNOW)),
    (re.compile(r"регион|област|город", re.I), ("Назову позже", DONT_KNOW)),
    (re.compile(r"кровл|площадк|площад[ьи]", re.I), ("Плоская кровля", "Скатная кровля", "Свободная площадка", DONT_KNOW)),
    (re.compile(r"потреблен|профил|киловатт|кВт·?ч", re.I), ("Назову позже", DONT_KNOW)),
    (re.compile(r"поставщик|ценов\w+ категори|тариф", re.I), ("Уточню у бухгалтерии", DONT_KNOW)),
)


def split_sentences(text: str) -> list:
    return [s.strip() for s in SENTENCE.split(" ".join(str(text or "").split())) if s.strip()]


def question_of(text: str) -> str:
    """Последний вопрос ответа бота (предложение с «?»); пусто, если бот ничего не спрашивает."""
    for s in reversed(split_sentences(text)):
        if s.endswith("?"):
            return s
    return ""


def field_value(passport, key: str) -> str:
    """Значение поля паспорта: представление {"fields": [{key, value}]} или плоский {ключ: значение}."""
    if not isinstance(passport, dict):
        return ""
    fields = passport.get("fields")
    if isinstance(fields, list):
        for f in fields:
            if isinstance(f, dict) and f.get("key") == key:
                v = f.get("value")
                return v.strip() if isinstance(v, str) else ""
        return ""
    v = passport.get(key)
    return v.strip() if isinstance(v, str) else ""


def task_options(passport) -> list:
    """Задачи, которые клиент ещё не назвал, — по закрытому списку поля паспорта."""
    chosen = field_value(passport, "task").lower()
    left = [label for value, label in TASK_VALUES.items() if value not in chosen]
    return left[: MAX_OPTIONS - 1] + [DONT_KNOW]


NO_METERS = "Приборов учёта пока нет"
# Поля паспорта, по которым видно, что приборы у клиента уже есть («около 40 счётчиков»).
METER_FIELDS = ("meters", "meter_fleet", "metering", "metering_data")


# Клиент сам упомянул приборы («около 40 счётчиков», «Меркурий 230»): паспорт этого хода ещё не готов —
# он считается после ответа, — поэтому смотрим и на реплики клиента.
METERS_SAID = re.compile(r"счётчик|счетчик|прибор\w* учёт|прибор\w* учет|меркури|энергомер|нартис|милур", re.I)


def meter_options(passport, client: str = "") -> list:
    """Кнопки на вопрос о приборах: «пока нет» не предлагаем, если клиент уже сказал о своих приборах."""
    has = any(field_value(passport, k) for k in METER_FIELDS) or bool(METERS_SAID.search(client or ""))
    return ([] if has else [NO_METERS]) + ["Приборы есть, подробности пришлю", DONT_KNOW]


def suggest(text: str, passport=None, has_lead: bool = False, client: str = "") -> list:
    """2–4 кнопки на уточняющий вопрос из ответа бота или []. client — реплики клиента одной строкой."""
    q = question_of(text)
    if not q:
        return []
    sentences = split_sentences(text)
    nearby = " ".join(sentences[max(0, sentences.index(q) - 1): sentences.index(q) + 1])  # вопрос и фраза перед ним
    if HANDOFF.search(nearby):
        # Заявка уже принята — повторно её не предлагаем и кнопок не строим.
        return [] if has_lead else ["Да, передайте менеджеру", "Пока продолжим здесь"]
    options = None
    for pattern, variants in RULES:
        if pattern.search(q):
            options = (task_options(passport) if variants == "task"
                       else meter_options(passport, client) if variants == "meters" else list(variants))
            break
    if options is None and YES_NO.match(q):
        options = ["Да", "Нет", DONT_KNOW]
    if not options:
        return []
    options = list(dict.fromkeys(options))[:MAX_OPTIONS]
    return options if len(options) >= MIN_OPTIONS else []
