"""Уровень объяснения «проще / технически» (T16): строка в промпте — только в режиме chat.

Автопроверка (mode != "chat") и копилот получают промпт байт в байт как без уровня. Уровень не добавляет фактов:
меняется только блок уровня, остальной промпт тот же. Без модели и без сети.

    python -m unittest tests.test_level -v
"""

from __future__ import annotations

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

from energybot.factmap import build_fm_messages  # noqa: E402
from energybot.prompts import LEVEL_HINT, LEVELS, ROLES, build_messages, build_write_messages, level_hint  # noqa: E402

TURNS = [{"role": "user", "content": "Чем мощность отличается от энергии?"}]
STYLES = ("tight", "full", "recipe", "jury", "jury2")
MARK = "Уровень объяснения:"


def prompts(mode: str, level: str, role: str = "") -> list:
    """Все сборки промпта ответа: обычная (по стилям, с планом и заданием опоры), двухшаговая и factmap."""
    out = []
    for style in STYLES:
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, near=2, role=role, level=level))
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, plan=2, full_kb=True, role=role, level=level))
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, task="ОПОРА", role=role, level=level))
    out.append(build_write_messages("МАТ", TURNS, "черновик", mode, role=role, level=level))
    out.append(build_fm_messages("КАРТА", "МАТ", TURNS, mode, role=role, level=level))
    return ["\n".join(m["content"] for m in msgs) for msgs in out]


class LevelHintPrompt(unittest.TestCase):
    def test_eval_and_copilot_prompts_do_not_change(self):
        for mode in ("eval", "copilot"):
            plain = prompts(mode, "")
            for level in LEVELS:
                self.assertEqual(prompts(mode, level), plain, f"{mode}/{level}")
                self.assertEqual(prompts(mode, level, role="grid"), prompts(mode, "", role="grid"), f"{mode}/{level}/grid")
            self.assertNotIn(MARK, "\n".join(plain), mode)

    def test_chat_gets_one_line_only_with_known_level(self):
        for level, style in LEVELS.items():
            for text in prompts("chat", level):
                self.assertEqual(text.count(MARK), 1, level)
                line = next(ln for ln in text.splitlines() if ln.startswith(MARK))
                self.assertEqual(line, LEVEL_HINT.strip().format(style=style), "одна строка, целиком")
        plain = prompts("chat", "")
        self.assertNotIn(MARK, "\n".join(plain))
        self.assertEqual(prompts("chat", "expert"), plain)

    def test_levels_differ_only_by_the_level_block(self):
        # Два уровня: промпты различаются только строкой уровня — правила, справочник, материалы и диалог те же.
        for style in STYLES:
            sys_s, user_s = build_messages("СПР", "МАТ", TURNS, "chat", style=style, near=2, level="simple")
            sys_t, user_t = build_messages("СПР", "МАТ", TURNS, "chat", style=style, near=2, level="technical")
            self.assertEqual(user_s["content"], user_t["content"])
            base = build_messages("СПР", "МАТ", TURNS, "chat", style=style, near=2)[0]["content"]
            self.assertEqual(sys_s["content"], base + level_hint("chat", "simple"))
            self.assertEqual(sys_t["content"], base + level_hint("chat", "technical"))
        simple, technical = level_hint("chat", "simple"), level_hint("chat", "technical")
        self.assertNotEqual(simple, technical)

    def test_level_goes_after_role_at_the_end(self):
        system = build_messages("СПР", "МАТ", TURNS, "chat", near=2, role="grid", level="simple")[0]["content"]
        self.assertTrue(system.endswith(level_hint("chat", "simple")))
        self.assertIn("Собеседник, вероятно:", system)
        self.assertLess(system.index("Собеседник, вероятно:"), system.index(MARK))

    def test_hint_brings_no_facts(self):
        # Ни одного числа и ни одного названия продукта сверх «только по базе».
        for level in LEVELS:
            hint = level_hint("chat", level)
            self.assertIsNone(re.search(r"\d", hint), level)
            self.assertIn("отвечай только по базе", hint)
            self.assertIn("не добавляет фактов", hint)
        self.assertEqual(level_hint("eval", "simple"), "")
        self.assertEqual(level_hint("copilot", "technical"), "")

    def test_same_levels_in_service_and_web(self):
        go = re.findall(r'\bLevel\w*\s+Level\s+=\s+"(\w+)"', (ROOT / "backend/internal/session/level.go").read_text("utf-8"))
        web = (ROOT / "web/src/lib/level.ts").read_text("utf-8")
        web_ids = re.findall(r'"(\w+)"', re.search(r"LEVEL_IDS = \[([^\]]*)\]", web).group(1))
        self.assertEqual(go, list(LEVELS))
        self.assertEqual(web_ids, list(LEVELS))
        self.assertTrue(set(ROLES))  # роли и уровни — независимые списки


def offline_app() -> core_api.App:
    api = core_api.WebApi()
    api.base_url = ""
    with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": ""}):
        for key in ("EB_CONFIDENCE_GATE", "EB_CONFIDENCE_THRESHOLD"):
            os.environ.pop(key, None)
        return core_api.App(api)


class LevelThroughCore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = offline_app()

    def ask(self, body: dict) -> tuple:
        seen = []

        def generate(messages, *a, **kw):
            seen.append("\n".join(m["content"] for m in messages))
            return "Мощность это то, сколько вы способны потреблять одновременно.", ""

        with mock.patch.object(self.app.bot, "generate", side_effect=generate):
            payload = self.app.chat({"messages": TURNS, **body}, lambda *a: None)
        return payload, seen

    def test_level_reaches_chat_prompt(self):
        payload, seen = self.ask({"mode": "chat", "level": "technical"})
        self.assertEqual(payload["level"], "technical")
        self.assertTrue(seen)
        self.assertIn(level_hint("chat", "technical").strip(), seen[0])

    def test_two_levels_same_prompt_except_level_block(self):
        _, simple = self.ask({"mode": "chat", "level": "simple"})
        _, technical = self.ask({"mode": "chat", "level": "technical"})
        self.assertEqual(len(simple), len(technical))
        for a, b in zip(simple, technical):
            self.assertEqual(a.replace(level_hint("chat", "simple"), ""),
                             b.replace(level_hint("chat", "technical"), ""))

    def test_eval_copilot_and_bad_level_go_without_it(self):
        for body in ({"mode": "eval", "level": "simple"}, {"mode": "copilot", "level": "simple"},
                     {"mode": "chat", "level": "expert"}, {"mode": "chat", "level": ["simple"]}, {"mode": "chat"}):
            payload, seen = self.ask(body)
            self.assertEqual(payload["level"], "", body)
            self.assertNotIn(MARK, "\n".join(seen), body)

    def test_eval_prompt_is_the_same_with_and_without_level(self):
        _, with_level = self.ask({"mode": "eval", "level": "technical"})
        _, without = self.ask({"mode": "eval"})
        self.assertEqual(with_level, without)


if __name__ == "__main__":
    unittest.main()
