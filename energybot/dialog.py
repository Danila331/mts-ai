"""Разбор входа: одиночный вопрос или диалог «Пользователь: … / Ассистент: …» одной строкой."""

from __future__ import annotations

import re

ROLE = re.compile(r"^\s*(Пользователь|Клиент|User|Ассистент|Консультант|Бот|Assistant)\s*:\s*", re.I | re.M)
ASSISTANT_NAMES = {"ассистент", "консультант", "бот", "assistant"}


def parse(question: str) -> list:
    """Возвращает список {"role", "content"}; последняя реплика — пользователя."""
    text = question.strip()
    matches = list(ROLE.finditer(text))
    if not matches:
        return [{"role": "user", "content": text}]
    turns = []
    head = text[: matches[0].start()].strip()
    if head:
        turns.append({"role": "user", "content": head})
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        role = "assistant" if m.group(1).lower() in ASSISTANT_NAMES else "user"
        content = " ".join(text[m.end():end].split())
        if not content:
            continue
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += " " + content
        else:
            turns.append({"role": role, "content": content})
    if turns and turns[-1]["role"] != "user":
        # Нечего отвечать: последняя реплика ассистента. Не теряем её смысл.
        turns.append({"role": "user", "content": "Продолжите, пожалуйста."})
    return turns


NEW_TOPIC = re.compile(
    r"\b(?:другой\s+вопрос|другой\s+объект|новая\s+тема|сменим\s+тему|"
    r"перейд[её]м\s+к|теперь\s+друг\w*)",
    re.I,
)


def current_segment(turns: list) -> list:
    """Текущая тема диалога: явная смена темы или продукта отсекает старую историю.

    Короткие продолжения в том же продукте сегмент не начинают: «а фасад?» после СЭС
    сохраняет контекст, а «другой объект» или переход СЭС → опт начинает новый.
    """
    if len(turns) < 2:
        return turns
    from .slots import product_from_dialog

    start = 0
    previous_product = ""
    for i, turn in enumerate(turns):
        if turn.get("role") != "user":
            continue
        content = turn.get("content", "")
        product = product_from_dialog(content)
        if i > 0 and NEW_TOPIC.search(content):
            start = i
        elif product and previous_product and product != previous_product:
            start = i
        if product:
            previous_product = product
    return turns[start:]


def search_queries(turns: list) -> tuple:
    """Запросы по текущему сегменту: лексический (последний вопрос с весом) и смысловой."""
    turns = current_segment(turns)
    last = turns[-1]["content"]
    users = [t["content"] for t in turns[:-1] if t["role"] == "user"]
    prev_assistant = next((t["content"] for t in reversed(turns[:-1]) if t["role"] == "assistant"), "")
    short_continuation = (
        len(re.findall(r"\w+", last)) <= 8 and bool(users)
        and re.search(r"\b(?:тоже|также|ещё|еще)\b", last, re.I)
    )
    lexical = " ".join([last, last] + users + ([] if short_continuation else [prev_assistant]))
    # Для эмбеддинга и реранкера — связный текст ситуации клиента.
    # Первая реплика пользователя обязательна: она несёт тему («автоматический учёт»),
    # а окно последних двух её вытесняет (demo-18 терял предмет из-за этого).
    # В коротком продолжении («а фасад?») прошлый ответ и предыдущая деталь наоборот
    # уводят запрос в предыдущий подвопрос, поэтому остаются якорь темы и текущая реплика.
    anchor = [users[0]] if users and users[0] not in users[-2:] else []
    middle = [] if short_continuation else users[-2:] + ([prev_assistant] if prev_assistant else [])
    semantic = " ".join(anchor + middle + [last])
    return lexical, semantic, last
