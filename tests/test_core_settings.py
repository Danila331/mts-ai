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
        with self.assertRaisesRegex(ValueError, "top_k: от 0 до 30"):
            self.settings.overrides({"top_k": 99})
        with self.assertRaisesRegex(ValueError, "неизвестные настройки: model"):
            self.settings.overrides({"model": "other"})
        with self.assertRaisesRegex(ValueError, "overrides: ожидается объект"):
            self.settings.overrides(["top_k"])
        self.assertEqual(self.settings.overrides(None), ({}, {}))

    def test_sandbox_cannot_inflate_answer_cost(self):
        # Администратор может поднять контекст и токены до предела, анонимная песочница — нет.
        with self.assertRaisesRegex(ValueError, "context_chars: в песочнице — не больше"):
            self.settings.overrides({"context_chars": 200000})
        with self.assertRaisesRegex(ValueError, "max_tokens: в песочнице — не больше"):
            self.settings.overrides({"max_tokens": 8192})
        self.settings.validate({"context_chars": 200000, "max_tokens": 8192})  # глобально — можно
        applied, _ = self.settings.overrides({"context_chars": 30000, "max_tokens": 1024})
        self.assertEqual(applied, {"context_chars": 30000, "max_tokens": 1024})
        meta = {f["key"]: f for f in self.settings.snapshot("")["fields"]}
        self.assertEqual(meta["max_tokens"]["sandbox_max"], max(2048, self.settings.values()["max_tokens"]))

    def test_override_is_visible_only_in_its_own_thread(self):
        before = self.settings.values()
        top_k = 1 if before["top_k"] != 1 else 2
        temperature = 1.5 if before["temperature"] != 1.5 else 0.5
        applied, values = self.settings.overrides({"top_k": top_k, "temperature": temperature,
                                                   "use_reference": False})
        self.assertEqual(applied, {"top_k": top_k, "temperature": temperature, "use_reference": False})

        inside, entered, release = {}, threading.Event(), threading.Event()

        def answer_with_sandbox():
            with core_api.overridden(values):
                inside["top_k"], inside["temperature"] = self.bot.top_k, self.api.temperature
                inside["reference_text"] = self.bot.reference_text
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

        self.assertEqual(inside, {"top_k": top_k, "temperature": temperature, "reference_text": ""})
        self.assertEqual(self.settings.values(), before, "после ответа общие настройки не изменились")

    def test_global_update_still_changes_everyone(self):
        before = self.settings.values()
        try:
            self.settings.update({"near": 3 if before["near"] != 3 else 4})
            seen = {}
            t = threading.Thread(target=lambda: seen.update(near=self.bot.near))
            t.start()
            t.join(5)
            self.assertEqual(seen["near"], self.settings.values()["near"])
        finally:
            self.settings.reset()
        self.assertEqual(self.settings.values(), before)


if __name__ == "__main__":
    unittest.main()
