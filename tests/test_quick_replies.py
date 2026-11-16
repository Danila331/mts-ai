"""Ответ и диалог (T31): кнопки быстрых ответов, один вопрос за ход, «не знаю» в первой строке.

Без модели и без сети.

    python -m unittest tests.test_quick_replies -v
"""

from __future__ import annotations

import json
import os
import re
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

import quick_replies  # noqa: E402

from energybot.pipeline import Answer  # noqa: E402


def user(text) -> list:
    return [{"role": "user", "content": text}]


class Suggest(unittest.TestCase):
    def test_deterministic(self):
        text = "Платформа это умеет. Какая у вас задача?"
        first = quick_replies.suggest(text, None)
        for _ in range(5):
            self.assertEqual(quick_replies.suggest(text, None), first)

    def test_no_question_no_buttons(self):
        self.assertEqual(quick_replies.suggest("Платформа собирает показания автоматически.", None), [])
        self.assertEqual(quick_replies.suggest("", None), [])
        self.assertEqual(quick_replies.suggest("Какой-то вопрос без правила и без да-нет?", None), [])

    def test_bounds_and_dont_know(self):
        questions = [
            "Какая у вас задача?", "Как сейчас собираете показания?", "Сколько у вас приборов учёта?",
            "Какая присоединённая мощность?", "В каком вы регионе?", "Какая у вас кровля?",
            "Каков профиль потребления?", "Кто ваш текущий поставщик?", "Есть ли у вас интервальный учёт?",
        ]
        for q in questions:
            got = quick_replies.suggest(f"Понял вас. {q}", None)
            self.assertTrue(quick_replies.MIN_OPTIONS <= len(got) <= quick_replies.MAX_OPTIONS, q)
            self.assertEqual(len(got), len(set(got)), q)
            self.assertIn(quick_replies.DONT_KNOW, got, q)
            self.assertTrue(all(0 < len(x) <= 45 for x in got), q)

    def test_only_last_question_counts(self):
        got = quick_replies.suggest("Есть ли у вас приборы учёта? Какая у вас задача?", None)
        self.assertIn("Найти потери", got)

    def test_tasks_follow_passport(self):
        passport = {"fields": [{"key": "task", "value": "поиск потерь"}]}
        got = quick_replies.suggest("Какая у вас задача?", passport)
        self.assertNotIn("Найти потери", got)
        self.assertIn("Снизить платёж", got)
        self.assertEqual(quick_replies.suggest("Какая у вас задача?", {"task": "поиск потерь"}), got)

    def test_meters_follow_passport(self):
        q = "Какие типы приборов сейчас стоят на складах?"
        self.assertIn(quick_replies.NO_METERS, quick_replies.suggest(q, None))
        passport = {"fields": [{"key": "meters", "value": "около 40 счётчиков"}]}
        got = quick_replies.suggest(q, passport)
        self.assertNotIn(quick_replies.NO_METERS, got, "клиент уже сказал, что приборы есть")
        self.assertEqual(got, ["Приборы есть, подробности пришлю", quick_replies.DONT_KNOW])
        # Первый ход: паспорта ещё нет, но клиент сам сказал о счётчиках.
        said = "У нас три склада и около 40 счётчиков, показания снимаем вручную."
        self.assertNotIn(quick_replies.NO_METERS, quick_replies.suggest(q, None, client=said))

    def test_handoff_offer(self):
        got = quick_replies.suggest("Могу передать запрос менеджеру. Передать?", None)
        self.assertEqual(len(got), 2)
        self.assertEqual(quick_replies.suggest("Могу передать запрос менеджеру. Передать?", None, has_lead=True), [])

    def test_tasks_match_passport_options(self):
        """Кнопки задач — по закрытому списку поля «Задача» паспорта (Go: passport.Tasks)."""
        go = (ROOT / "backend/internal/passport/passport.go").read_text(encoding="utf-8")
        listed = re.search(r"var Tasks = \[\]string\{(.+?)\}", go).group(1)
        tasks = re.findall(r'"([^"]+)"', listed)
        self.assertEqual(sorted(tasks), sorted(quick_replies.TASK_VALUES))

    def test_no_promises_in_buttons(self):
        everything = [x for _, v in quick_replies.RULES if isinstance(v, tuple) for x in v]
        everything += list(quick_replies.TASKS) + ["Да, передайте менеджеру", "Пока продолжим здесь"]
        for x in everything:
            self.assertNotRegex(x.lower(), r"\d|срок|через|час|завтра|гаранти")


class CoreAnswer(unittest.TestCase):
    def app(self, text):
        api = core_api.WebApi()
        api.base_url = ""
        with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": "", "EB_CONFIDENCE_GATE": "0"}):
            app = core_api.App(api)
        app.bot.answer = lambda turns, mode="eval", **kw: Answer(text, [], {"total": 0.0})
        return app

    def test_suggestions_only_in_chat(self):
        app = self.app("Платформа это умеет. Какая у вас задача?")
        body = {"messages": user("Что умеет платформа учёта?")}
        chat = app.chat(body | {"mode": "chat"}, lambda *a: None)
        self.assertTrue(2 <= len(chat["suggestions"]) <= 4)
        for mode in ("eval", "copilot"):
            self.assertEqual(app.chat(body | {"mode": mode}, lambda *a: None)["suggestions"], [], mode)

    def test_eval_payload_unchanged_apart_from_empty_field(self):
        app = self.app("Платформа это умеет. Какая у вас задача?")
        payload = app.chat({"messages": user("Привет"), "mode": "eval"}, lambda *a: None)
        self.assertEqual(payload["suggestions"], [])
        self.assertEqual(payload["text"], "Платформа это умеет. Какая у вас задача?")

    def test_fallback_has_no_buttons(self):
        from energybot.pipeline import FALLBACK
        app = self.app(FALLBACK)
        chat = app.chat({"messages": user("Привет"), "mode": "chat"}, lambda *a: None)
        self.assertEqual(chat["suggestions"], [])


class PromptRules(unittest.TestCase):
    def test_one_clarifying_question_rule_in_built_prompt(self):
        from energybot.prompts import build_messages
        for mode in ("chat", "eval"):
            text = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", user("Хотим учёт"), mode))
            self.assertIn("Никогда не больше одного вопроса", text, mode)
            self.assertIn("Один короткий уточняющий вопрос", text, mode)

    def test_unknown_first_block_only_in_chat(self):
        from energybot.factmap import build_fm_messages
        from energybot.prompts import CHAT_UNKNOWN_FIRST, build_messages, build_write_messages
        block = CHAT_UNKNOWN_FIRST.strip()
        turns = user("Какой у вас SLA?")
        for style in ("tight", "full", "recipe", "jury", "jury2"):
            for plan in (0, 1, 2):
                msgs = build_messages("СПР", "МАТ", turns, "eval", style=style, plan=plan)
                self.assertNotIn("ЕСЛИ ОТВЕТА В БАЗЕ НЕТ", "\n".join(m["content"] for m in msgs), style)
            for mode, present in (("chat", True), ("copilot", False)):
                text = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", turns, mode, style=style))
                self.assertEqual(block in text, present, (style, mode))
        for builder in (lambda m: build_write_messages("МАТ", turns, "черновик", m),
                        lambda m: build_fm_messages("КАРТА", "МАТ", turns, m)):
            self.assertNotIn(block, "\n".join(x["content"] for x in builder("eval")))
            self.assertIn(block, "\n".join(x["content"] for x in builder("chat")))
        self.assertIn("в первом же предложении", block)

    def test_out_of_kb_references_say_unknown_first(self):
        """Эталоны out-of-kb начинаются с «в материалах нет/не описано/не могу»: правило промпта им соответствует."""
        marker = re.compile(r"\b(нет|не описан\w*|не указан\w*|не могу|не буду|не знаю|не раскрыва\w*|не упомина\w*|"
                            r"не приведен\w*|не названа|не названы|не определ\w*|не содержит)\b", re.I)
        cases = [json.loads(line) for line in (ROOT / "eval/dataset/cases.jsonl").read_text(encoding="utf-8").splitlines()
                 if line.strip()]
        refs = [c for c in cases if c["category"] == "out-of-kb"]
        self.assertGreaterEqual(len(refs), 50)
        first = lambda c: re.split(r"(?<=[.!?])\s", c["reference"].strip())[0]  # noqa: E731
        late = [c["id"] for c in refs if not marker.search(first(c))]
        # Допуск: в нескольких эталонах «в базе есть только часть» — оговорка сразу после ответа по существу.
        self.assertLessEqual(len(late), 0.1 * len(refs), late)


if __name__ == "__main__":
    unittest.main()
