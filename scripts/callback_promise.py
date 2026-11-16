"""Без обещаний времени звонка в чате с клиентом.

База (00-reference/03-calculation-and-requests.md, «Обратный звонок»): нельзя обещать точное время звонка,
имя специалиста или содержание разговора. Промпт это запрещает (energybot/prompts.py, CHAT_LEAD_KINDS), но
модель повторяет пожелание клиента как обещание: клиент — «звоните после 14:00», бот — «менеджер свяжется
с вами после 14:00». Проверка цифр такое пропускает: число есть в диалоге. Здесь — детерминированная правка
после генерации: предложение с обещанием времени заменяется нейтральным «учтём».

Только режим chat (scripts/core_api.py): автопроверка (solution.py) и копилот этот модуль не вызывают.
"""

from __future__ import annotations

import re

# Тот же текст, что в форме после отправки (web/src/lib/callback.ts: CALLBACK_NOTED).
NOTED = "Менеджер учтёт удобное время."

SENTENCE = re.compile(r"(?<=[.!?…])\s+")
CALL = re.compile(r"\b(?:свяж\w*|позвон\w*|перезвон\w*|набер\w*|выйд\w* на связь|звон(?:ок|ка|ком))", re.I)
WHEN = re.compile(
    r"(?:\b(?:в|во|после|до|с|со|около|к|ровно)\s+\d{1,2}(?:[:.]\d{2})?(?!\d)(?:\s*(?:час\w*|ч\b))?"
    r"|\b(?:сегодня|завтра|послезавтра)\b"
    r"|\bв\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\b"
    r"|\bв\s+течение\s+(?:\d+\s+|одного\s+|часа|дня|рабоч\w+\s+)*(?:минут\w*|час\w*|дн\w+|сут\w+)"
    r"|\bчерез\s+(?:\d+\s+|пару\s+|несколько\s+)?(?:минут\w*|час\w*|дн\w+))",
    re.I,
)


def promises_time(sentence: str) -> bool:
    return bool(CALL.search(sentence) and WHEN.search(sentence))


def soften(text: str) -> str:
    """Предложения с обещанием времени звонка → «Менеджер учтёт удобное время.» (один раз за ответ)."""
    parts = [s for s in SENTENCE.split(str(text or "").strip()) if s]
    if not any(promises_time(s) for s in parts):
        return text
    out, noted = [], False
    for s in parts:
        if not promises_time(s):
            out.append(s)
        elif not noted:
            out.append(NOTED)
            noted = True
    return " ".join(out)
