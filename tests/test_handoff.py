"""Бот сам предлагает передать разговор менеджеру: триггеры, подавление, текст без обещаний, только режим chat.

Без модели и без сети.

    python -m unittest tests.test_handoff -v
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

import callback_promise  # noqa: E402
import handoff  # noqa: E402
import quick_replies  # noqa: E402

from energybot.pipeline import FALLBACK, Answer  # noqa: E402

PLAIN = "Платформа собирает показания со счётчиков автоматически."


def u(text):
    return {"role": "user", "content": text}


def a(text):
    return {"role": "assistant", "content": text}


def passport(product="general", **fields):
    return {"product": product, "handoff_agreed": False,
            "fields": [{"key": k, "value": v} for k, v in fields.items()]}


class Triggers(unittest.TestCase):
    def test_commercial_question(self):
        for q in ("Сколько стоит платформа?", "Дайте коммерческое предложение", "Как подключить учёт?",
                  "Какие условия договора?", "Нужен расчёт экономии", "Как заказать солнечную станцию?",
                  "Какая цена у лицензии?"):
            r = handoff.decide([u(q)], None, PLAIN)
            self.assertEqual(r and r["reason"], "commercial", q)

    def test_unknown_in_answer(self):
        for text in ("Точная цифра в материалах не описана.", "Этого нет в материалах.",
                     "Детали уточнит специалист.", "Срок подскажет менеджер."):
            r = handoff.decide([u("Расскажите про учёт")], None, text)
            self.assertEqual(r and r["reason"], "unknown", text)

    def test_task_is_clear_by_passport(self):
        p = passport("platform", task="автоматизация учёта", object_type="склад")
        r = handoff.decide([u("Нужен учёт на складе")], p, PLAIN)
        self.assertEqual(r and r["reason"], "task_clear")

    def test_one_field_or_general_product_is_not_enough(self):
        self.assertIsNone(handoff.decide([u("Нужен учёт")], passport("platform", task="поиск потерь"), PLAIN))
        self.assertIsNone(handoff.decide([u("Нужен учёт")], passport("general", task="x", region="y"), PLAIN))

    def test_contacts_are_not_task_fields(self):
        p = passport("platform", task="поиск потерь", callback_preference="после обеда")
        self.assertIsNone(handoff.decide([u("Нужен учёт")], p, PLAIN))

    def test_three_client_messages_with_product(self):
        turns = [u("Привет"), a("Здравствуйте."), u("Нужен учёт"), a(PLAIN), u("А ещё?")]
        r = handoff.decide(turns, passport("platform"), PLAIN)
        self.assertEqual(r and r["reason"], "long_dialog")
        self.assertIsNone(handoff.decide(turns, passport("general"), PLAIN))
        self.assertIsNone(handoff.decide(turns[:3], passport("platform"), PLAIN))

    def test_weak_reasons_do_not_stack_a_second_question(self):
        p = passport("platform", task="поиск потерь", region="Тверь")
        self.assertIsNone(handoff.decide([u("Нужен учёт")], p, "Подойдёт платформа. Сколько у вас объектов?"))
        r = handoff.decide([u("Сколько стоит?")], p, "Подойдёт платформа. Сколько у вас объектов?")
        self.assertEqual(r["reason"], "commercial")

    def test_nothing_to_say_when_nothing_happens(self):
        self.assertIsNone(handoff.decide([u("Что такое АСКУЭ?")], None, PLAIN))
        self.assertIsNone(handoff.decide([], None, PLAIN))


class Suppression(unittest.TestCase):
    ASK = [u("Сколько стоит платформа?")]

    def test_lead_exists(self):
        self.assertIsNone(handoff.decide(self.ASK, None, PLAIN, has_lead=True))

    def test_handoff_agreed_or_contacts_in_passport(self):
        self.assertIsNone(handoff.decide(self.ASK, {"handoff_agreed": True, "fields": []}, PLAIN))
        self.assertIsNone(handoff.decide(self.ASK, passport(phone="+7 900 000-00-00"), PLAIN))
        self.assertIsNone(handoff.decide(self.ASK, passport(name="Тест"), PLAIN))

    def test_client_declined_recently(self):
        for refusal in ("Пока не готов", "Не нужно менеджера", "Без менеджера, пожалуйста", "Не звоните мне",
                        "Пока продолжим здесь"):
            turns = [u(refusal), a(PLAIN)] + self.ASK
            self.assertIsNone(handoff.decide(turns, None, PLAIN), refusal)

    def test_old_decline_is_forgotten(self):
        turns = [u("Пока не готов"), a(PLAIN), u("раз"), a(PLAIN), u("два"), a(PLAIN)] + self.ASK
        self.assertIsNotNone(handoff.decide(turns, None, PLAIN))

    def test_offered_in_last_two_assistant_turns(self):
        offered = a("Ответ. " + handoff.OFFER)
        self.assertIsNone(handoff.decide([u("x"), offered, u("y"), a(PLAIN)] + self.ASK, None, PLAIN))
        self.assertIsNone(handoff.decide([u("x"), offered] + self.ASK, None, PLAIN))
        far = [u("x"), offered, u("y"), a(PLAIN), u("z"), a(PLAIN)] + self.ASK
        self.assertIsNotNone(handoff.decide(far, None, PLAIN))

    def test_model_already_asked_about_manager(self):
        self.assertIsNone(handoff.decide(self.ASK, None, "Цену уточнит специалист. Передать ваш запрос менеджеру?"))
        self.assertIsNone(handoff.decide(self.ASK, None, "Могу связаться с менеджером и оформить заявку."))


class Sentence(unittest.TestCase):
    def test_matches_quick_replies_handoff_and_gives_buttons(self):
        self.assertTrue(quick_replies.HANDOFF.search(handoff.OFFER))
        buttons = quick_replies.suggest(PLAIN + " " + handoff.OFFER)
        self.assertEqual(buttons, ["Да, передайте менеджеру", "Пока продолжим здесь"])

    def test_one_sentence_question_without_promises(self):
        text = handoff.OFFER.lower()
        self.assertTrue(text.rstrip().endswith("передать?"))
        self.assertFalse(callback_promise.promises_time(handoff.OFFER))
        for banned in ("свяжется", "позвон", "перезвон", "сегодня", "завтра", "руб", "₽", "гарант", "скидк", "бесплатно"):
            self.assertNotIn(banned, text)
        self.assertNotRegex(text, r"\d")
        self.assertEqual(callback_promise.soften(handoff.OFFER), handoff.OFFER)

    def test_append(self):
        offer = {"reason": "commercial", "text": handoff.OFFER}
        self.assertEqual(handoff.append("Ответ.\n", offer), "Ответ.\n\n" + handoff.OFFER)


class CoreAnswer(unittest.TestCase):
    def app(self, text, error=""):
        api = core_api.WebApi()
        api.base_url = ""
        with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": "", "EB_CONFIDENCE_GATE": "0"}):
            app = core_api.App(api)
        app.bot.answer = lambda turns, mode="eval", **kw: Answer(text, [], {"total": 0.0}, error=error)
        return app

    BODY = {"messages": [u("Сколько стоит платформа?")]}

    def chat(self, app, **extra):
        return app.chat(self.BODY | extra, lambda *a: None)

    def test_chat_appends_offer_and_buttons(self):
        payload = self.chat(self.app(PLAIN), mode="chat")
        self.assertEqual(payload["handoff"], {"reason": "commercial"})
        self.assertEqual(payload["text"], PLAIN + "\n\n" + handoff.OFFER)
        self.assertEqual(payload["suggestions"], ["Да, передайте менеджеру", "Пока продолжим здесь"])

    def test_eval_and_copilot_are_untouched(self):
        app = self.app(PLAIN)
        for mode in ("eval", "copilot"):
            payload = self.chat(app, mode=mode)
            self.assertNotIn("handoff", payload, mode)
            self.assertEqual(payload["text"], PLAIN, mode)
            self.assertEqual(payload["suggestions"], [], mode)

    def test_has_lead_flag_suppresses(self):
        payload = self.chat(self.app(PLAIN), mode="chat", has_lead=True)
        self.assertNotIn("handoff", payload)
        self.assertEqual(payload["text"], PLAIN)

    def test_fallback_and_error_get_no_offer(self):
        for app in (self.app(FALLBACK), self.app(PLAIN, error="boom")):
            payload = self.chat(app, mode="chat")
            self.assertNotIn("handoff", payload)
            self.assertNotIn(handoff.OFFER, payload["text"])

    def test_degraded_gets_no_offer(self):
        app = self.app(FALLBACK)
        payload = self.chat(app, mode="chat")
        self.assertNotIn("handoff", payload)

    def test_gated_clarify_gets_no_offer(self):
        app = self.app(PLAIN)
        app.gate = True
        app.threshold = 2.0  # любой поиск ниже порога
        app.bot.prefetch = lambda turns: {"score": 0.0}
        app.bot.clarify = lambda turns: Answer("Уточните, пожалуйста, задачу.", [], {"total": 0.0})
        payload = self.chat(app, mode="chat")
        self.assertEqual(payload["route"], "clarify")
        self.assertNotIn("handoff", payload)
        self.assertNotIn(handoff.OFFER, payload["text"])


if __name__ == "__main__":
    unittest.main()
