"""Настройки RAG ядра стенда (scripts/core_api.py): глобальные и песочница на один ответ.

    python -m unittest tests.test_core_settings -v
"""

from __future__ import annotations

import os
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# core_api при импорте читает .env и ставит свои умолчания (EB_STYLE): окружение остальных тестов
# этого процесса трогать нельзя — возвращаем его как было.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

KB_DIR = ROOT / "knowledge-base"


def make_settings():
    api = core_api.WebApi()
    api.base_url = ""  # без модели: тест не ходит в сеть, даже если в .env есть ключ
    bot = core_api.WebConsultant(KB_DIR, api=api)
    return bot, api, core_api.Settings(bot, api)


class SandboxOverrides(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bot, cls.api, cls.settings = make_settings()

    def test_same_limits_as_global_settings(self):
        with self.assertRaisesRegex(ValueError, "top_k: от 1 до 30"):
            self.settings.overrides({"top_k": 99})
        with self.assertRaisesRegex(ValueError, "неизвестные настройки: model"):
            self.settings.overrides({"model": "other"})
        with self.assertRaisesRegex(ValueError, "overrides: ожидается объект"):
            self.settings.overrides(["top_k"])
        self.assertEqual(self.settings.overrides(None), ({}, {}))

    def test_sandbox_cannot_inflate_answer_cost(self):
        # Администратор может поднять число кандидатов и токены до предела, анонимная песочница — нет.
        # v28: потолка песочницы у context_chars больше нет (в Settings он только у n_candidates и max_tokens).
        with self.assertRaisesRegex(ValueError, "n_candidates: в песочнице — не больше"):
            self.settings.overrides({"n_candidates": 80})
        with self.assertRaisesRegex(ValueError, "max_tokens: в песочнице — не больше"):
            self.settings.overrides({"max_tokens": 8192})
        self.settings.validate({"n_candidates": 80, "max_tokens": 8192})  # глобально — можно
        with self.assertRaisesRegex(ValueError, "context_chars: от 2000 до 60000"):
            self.settings.validate({"context_chars": 200000})  # общий предел поля остаётся
        applied, _ = self.settings.overrides({"n_candidates": 40, "max_tokens": 1024})
        self.assertEqual(applied, {"n_candidates": 40, "max_tokens": 1024})
        meta = {f["key"]: f for f in self.settings.snapshot("")["fields"]}
        self.assertEqual(meta["max_tokens"]["sandbox_max"], max(2048, self.settings.values()["max_tokens"]))
        self.assertEqual(meta["n_candidates"]["sandbox_max"], max(40, self.settings.values()["n_candidates"]))
        self.assertNotIn("sandbox_max", meta["context_chars"])

    def test_override_is_visible_only_in_its_own_thread(self):
        before = self.settings.values()
        top_k = 1 if before["top_k"] != 1 else 2
        temperature = 1.5 if before["temperature"] != 1.5 else 0.5
        expand = 0 if before["expand_docs"] != 0 else 1
        applied, values = self.settings.overrides({"top_k": top_k, "temperature": temperature,
                                                   "expand_docs": expand})
        self.assertEqual(applied, {"top_k": top_k, "temperature": temperature, "expand_docs": expand})

        inside, entered, release = {}, threading.Event(), threading.Event()

        def answer_with_sandbox():
            with core_api.overridden(values):
                inside["top_k"], inside["temperature"] = self.bot.top_k, self.api.temperature
                inside["expand_docs"] = self.bot.expand_docs
                entered.set()
                release.wait(5)  # соседний «запрос» читает настройки, пока этот ещё отвечает

        worker = threading.Thread(target=answer_with_sandbox)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            # Другой поток — другой посетитель: видит общие значения.
            self.assertEqual(self.settings.values(), before)
        finally:
            release.set()
            worker.join(5)

        self.assertEqual(inside, {"top_k": top_k, "temperature": temperature, "expand_docs": expand})
        self.assertEqual(self.settings.values(), before, "после ответа общие настройки не изменились")

    def test_global_update_still_changes_everyone(self):
        before = self.settings.values()
        try:
            self.settings.update({"expand_docs": 3 if before["expand_docs"] != 3 else 2})
            seen = {}
            t = threading.Thread(target=lambda: seen.update(expand_docs=self.bot.expand_docs))
            t.start()
            t.join(5)
            self.assertEqual(seen["expand_docs"], self.settings.values()["expand_docs"])
        finally:
            self.settings.reset()
        self.assertEqual(self.settings.values(), before)


if __name__ == "__main__":
    unittest.main()
