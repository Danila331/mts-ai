"""Бот сам предлагает передать разговор менеджеру (кейс: «ИИ сам понимает, что пора к менеджеру»).

Без модели и без сети: детерминированные правила по репликам клиента, паспорту задачи и тексту ответа.
Одинаковый диалог даёт одинаковое решение. Предложение — одна фраза без обещаний: время звонка, имя специалиста,
цена и результат не называются (база, 00-reference/03-calculation-and-requests.md, «Обратный звонок»).
Фраза совпадает с HANDOFF из scripts/quick_replies.py, поэтому под ней появляются кнопки
«Да, передайте менеджеру» / «Пока продолжим здесь».

Только режим chat (scripts/core_api.py): автопроверка (solution.py) и копилот этот модуль не вызывают.
"""

from __future__ import annotations

import re

from quick_replies import HANDOFF, field_value

OFFER = ("Могу передать ваш запрос менеджеру МТС: он уточнит детали по вашему объекту и предложит следующий шаг. "
         "Передать?")

# Клиент спрашивает о цене, расчёте, договоре, подключении или условиях — это уже коммерческий разговор.
COMMERCIAL = re.compile(
    r"сколько (?:это )?(?:будет )?(?:стоит|стоят|платить|заплатить)|стоимост|\bцен[аыуе]\b|\bценник|прайс|"
    r"расч[её]т\w*|рассчита\w+|коммерческ\w+ предложени|\bкп\b|договор|"
    r"как (?:можно )?(?:купить|заказать|оформить|подключить\w*|подключиться)|подключени\w+|подключить|"
    r"условия (?:подключения|сотрудничества|работы|поставки)|тарифы? (?:на|для) ", re.I)
# Ответ бота сам говорит, что в материалах этого нет или решает специалист.
UNKNOWN = re.compile(
    r"не описан\w*|нет в материалах|в материалах (?:нет|не\b)|не указан\w* в материалах|"
    r"(?:уточнит|уточнят|подскажет|рассчитает|определит|оценит) (?:\w+ )?(?:специалист|менеджер)\w*|"
    r"(?:специалист|менеджер)\w* (?:уточнит|уточнят|подскажет|рассчитает|определит|оценит)|"
    r"требует(?:ся)? уточнени\w+ у (?:специалист|менеджер)\w*|уточните у (?:специалист|менеджер)\w*", re.I)
# Клиент недавно отказался от менеджера.
DECLINE = re.compile(
    r"не готов\w*|не нужн\w*|не надо|без менеджера|не звоните|не беспокойте|не хочу (?:менеджер|звонк|общать)\w*|"
    r"пока не (?:нужно|надо|хочу|готов\w*|стоит|передавайте)|пока продолжим|продолжим здесь|"
    r"не передавайте|не нужен менеджер|сам разберусь", re.I)

RECENT_ASSISTANT = 2  # предложение было в одном из последних двух ответов бота — второй раз подряд не повторяем
RECENT_CLIENT = 3  # отказ среди последних трёх реплик клиента считается «недавним»
MIN_TASK_FIELDS = 2
MIN_CLIENT_MESSAGES = 2  # со второй реплики клиента разговор уже о его задаче — карточка менеджера видна всегда
GENERAL = "general"
# Контакты — не сведения о задаче (backend/internal/passport: группа Contacts).
CONTACT_KEYS = ("name", "phone", "company", "callback_preference")


def _contents(turns: list, role: str) -> list:
    return [str(t.get("content", "")) for t in turns if isinstance(t, dict) and t.get("role") == role]


def _filled_task_fields(passport) -> int:
    if not isinstance(passport, dict):
        return 0
    fields = passport.get("fields")
    if isinstance(fields, list):
        return sum(1 for f in fields if isinstance(f, dict) and f.get("key") not in CONTACT_KEYS
                   and isinstance(f.get("value"), str) and f["value"].strip())
    return sum(1 for k, v in passport.items() if k not in CONTACT_KEYS and isinstance(v, str) and v.strip()
               and k not in ("product", "product_label"))


def _product(passport) -> str:
    v = passport.get("product") if isinstance(passport, dict) else ""
    return v.strip() if isinstance(v, str) and v.strip() != GENERAL else ""


def suppressed(turns: list, passport, answer_text: str, has_lead: bool = False) -> bool:
    """Предлагать нельзя совсем: заявка уже есть или идёт, клиент недавно отказался."""
    if has_lead:
        return True
    if isinstance(passport, dict) and passport.get("handoff_agreed"):
        return True  # клиент уже согласился — форма заявки и так открыта
    if any(field_value(passport, k) for k in ("phone", "name")):
        return True  # контакты уже в паспорте — заявка в работе
    return any(DECLINE.search(c) for c in _contents(turns, "user")[-RECENT_CLIENT:])


def decide(turns: list, passport, answer_text: str, has_lead: bool = False):
    """{"reason", "text"}, если пора предложить менеджера, иначе None.

    Карточка «Передать менеджеру» (payload.handoff) показывается при любой причине. Фраза-вопрос text дописывается
    к ответу, только если в нём нет своего вопроса и предложения не было в последних ответах — иначе text пустой:
    одна карточка, без второго вопроса подряд и без повтора одной и той же фразы.
    """
    client = _contents(turns, "user")
    if not client or suppressed(turns, passport, answer_text, has_lead):
        return None
    text = str(answer_text or "")
    reason = ""
    if HANDOFF.search(text):
        reason = "model_offer"  # модель сама предложила менеджера — под ответом нужна и карточка
    elif COMMERCIAL.search(client[-1]):
        reason = "commercial"
    elif UNKNOWN.search(text):
        reason = "unknown"
    elif _product(passport) and _filled_task_fields(passport) >= MIN_TASK_FIELDS:
        reason = "task_clear"
    elif len(client) >= MIN_CLIENT_MESSAGES:
        reason = "long_dialog"
    if not reason:
        return None
    recent = any(HANDOFF.search(c) for c in _contents(turns, "assistant")[-RECENT_ASSISTANT:])
    sentence = "" if reason == "model_offer" or recent or "?" in text else OFFER
    return {"reason": reason, "text": sentence}


def append(answer_text: str, offer: dict) -> str:
    if not offer.get("text"):
        return str(answer_text or "")
    return (str(answer_text or "").rstrip() + "\n\n" + offer["text"]).strip()
