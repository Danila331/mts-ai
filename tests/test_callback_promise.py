"""Бот не обещает время звонка (раздел базы «Обратный звонок»): scripts/callback_promise.py."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# core_api при импорте читает .env и ставит свои умолчания: окружение остальных тестов не трогаем.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

import callback_promise as cp  # noqa: E402

from energybot.pipeline import Answer  # noqa: E402


class Soften(unittest.TestCase):
    def test_promises_are_replaced(self):
        for s in [
            "Менеджер свяжется с вами после 14:00, чтобы уточнить детали.",
            "Менеджер позвонит вам завтра.",
            "Специалист перезвонит в течение часа.",
            "Мы свяжемся с вами в течение 2 рабочих дней.",
            "Менеджер наберёт вас в 10 утра.",
            "Звонок будет в понедельник.",
            "Менеджер свяжется через 15 минут.",
        ]:
            self.assertTrue(cp.promises_time(s), s)
            self.assertEqual(cp.soften(s), cp.NOTED, s)

    def test_live_answer_from_stand(self):
        text = ("Принял ваши данные для передачи менеджеру. Ниже откроется форма, в которой вы проверите контакты. "
                "Менеджер свяжется с вами после 14:00, чтобы уточнить детали по счетчикам Меркурий 230.")
        self.assertEqual(cp.soften(text), "Принял ваши данные для передачи менеджеру. Ниже откроется форма, в которой "
                                          "вы проверите контакты. " + cp.NOTED)

    def test_one_note_per_answer(self):
        got = cp.soften("Менеджер позвонит завтра. Если не дозвонится, перезвонит в течение часа.")
        self.assertEqual(got, cp.NOTED)

    def test_facts_without_time_promise_stay(self):
        for s in [
            "Менеджер свяжется с вами и уточнит детали.",
            "Обратный звонок — если удобнее устно описать объект.",
            "Ориентир — 25 000 руб в год за прибор.",
            "Платформа собирает показания каждые 30 минут.",
            "С 1 июля 2026 года меняются правила.",
            "Предварительная оценка не является коммерческим предложением.",
        ]:
            self.assertEqual(cp.soften(s), s, s)


class CoreAnswer(unittest.TestCase):
    TEXT = "Данные принял. Менеджер свяжется с вами после 14:00."

    def app(self):
        api = core_api.WebApi()
        api.base_url = ""
        with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": "", "EB_CONFIDENCE_GATE": "0"}):
            app = core_api.App(api)
        app.bot.answer = lambda turns, mode="eval", **kw: Answer(self.TEXT, [], {"total": 0.0})
        return app

    def test_only_chat_is_softened(self):
        app = self.app()
        body = {"messages": [{"role": "user", "content": "Звоните после 14:00"}]}
        self.assertEqual(app.chat(body | {"mode": "chat"}, lambda *a: None)["text"], "Данные принял. " + cp.NOTED)
        for mode in ("eval", "copilot"):
            self.assertEqual(app.chat(body | {"mode": mode}, lambda *a: None)["text"], self.TEXT, mode)


if __name__ == "__main__":
    unittest.main()
