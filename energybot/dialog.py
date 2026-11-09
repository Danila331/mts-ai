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


def search_queries(turns: list) -> tuple:
    """Запросы для поиска: лексический (последний вопрос с весом, ограниченное окно истории)
    и смысловой (связный текст ситуации клиента).

    Окно — последние три реплики пользователя: вся история в лексическом запросе
    размывает поиск при смене темы (клиент перешёл с солнечной станции на учёт,
    а старые термины продолжают тянуть чанки про панели).
    """
    last = turns[-1]["content"]
    users = [t["content"] for t in turns[:-1] if t["role"] == "user"]
    prev_assistant = next((t["content"] for t in reversed(turns[:-1]) if t["role"] == "assistant"), "")
    lexical = " ".join([last, last] + users[-3:] + [prev_assistant])
    # Для эмбеддинга и реранкера — связный текст ситуации клиента.
    semantic = " ".join(users[-2:] + ([prev_assistant] if prev_assistant else []) + [last])
    return lexical, semantic, last
