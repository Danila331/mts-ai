"""Роль-подсказка (T15): строка о собеседнике в промпте — только в режиме chat.

Автопроверка (mode != "chat") и копилот получают промпт байт в байт как без роли. Без модели и без сети.

    python -m unittest tests.test_role -v
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

# core_api при импорте читает .env и ставит свои умолчания: окружение остальных тестов не трогаем.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

from energybot.factmap import build_fm_messages  # noqa: E402
from energybot.prompts import ROLE_HINT, ROLES, build_messages, build_write_messages, role_hint  # noqa: E402

TURNS = [{"role": "user", "content": "Мы электросетевая компания, хотим находить потери"}]
STYLES = ("tight", "full", "recipe", "jury", "jury2")
MARK = "Собеседник, вероятно:"


def prompts(mode: str, role: str) -> list:
    """Все сборки промпта ответа: обычная (по стилям, с планом и заданием опоры), двухшаговая и factmap."""
    out = []
    for style in STYLES:
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, near=2, role=role))
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, plan=2, full_kb=True, role=role))
        out.append(build_messages("СПР", "МАТ", TURNS, mode, style=style, task="ОПОРА", role=role))
    out.append(build_write_messages("МАТ", TURNS, "черновик", mode, role=role))
    out.append(build_fm_messages("КАРТА", "МАТ", TURNS, mode, role=role))
    return ["\n".join(m["content"] for m in msgs) for msgs in out]


class RoleHintPrompt(unittest.TestCase):
    def test_eval_and_copilot_prompts_do_not_change(self):
        # Автопроверка и копилот: роль не меняет промпт ни на символ — какую бы роль ни прислали.
        for mode in ("eval", "copilot"):
            plain = prompts(mode, "")
            for role in ROLES:
                self.assertEqual(prompts(mode, role), plain, f"{mode}/{role}")
            self.assertNotIn(MARK, "\n".join(plain), mode)

    def test_chat_gets_one_line_only_with_known_role(self):
        for role, (who, focus) in ROLES.items():
            for text in prompts("chat", role):
                self.assertEqual(text.count(MARK), 1, role)
                line = next(ln for ln in text.splitlines() if ln.startswith(MARK))
                self.assertEqual(line, ROLE_HINT.strip().format(who=who, focus=focus), "одна строка, целиком")
        # Без роли и с неизвестной ролью — промпт чата как раньше.
        plain = prompts("chat", "")
        self.assertNotIn(MARK, "\n".join(plain))
        self.assertEqual(prompts("chat", "admin"), plain)
        grid = prompts("chat", "grid")
        self.assertIn("Собеседник, вероятно: электросетевая компания.", grid[0])
        # Строка — в конце системного промпта: правила, справочник и примеры остаются общим префиксом.
        system = build_messages("СПР", "МАТ", TURNS, "chat", near=2, role="grid")[0]["content"]
        self.assertTrue(system.endswith(role_hint("chat", "grid")))
        self.assertEqual(system[: -len(role_hint("chat", "grid"))],
                         build_messages("СПР", "МАТ", TURNS, "chat", near=2)[0]["content"])

    def test_hint_brings_no_facts(self):
        # Подсказка не приносит фактов: ни чисел, ни продуктов сверх «Навигации по типу компании» в базе.
        for role in ROLES:
            hint = role_hint("chat", role)
            self.assertIsNone(re.search(r"\d", hint), role)
            self.assertIn("отвечай только по базе", hint)
        self.assertEqual(role_hint("eval", "grid"), "")
        self.assertEqual(role_hint("copilot", "grid"), "")

    def test_same_roles_in_service_and_web(self):
        # Список ролей — в трёх местах: шлюз проверяет, фронт показывает, ядро подсказывает промпту.
        go = re.findall(r'\bRole\w*\s+Role\s+=\s+"(\w+)"', (ROOT / "backend/internal/session/role.go").read_text("utf-8"))
        web = (ROOT / "web/src/lib/roles.ts").read_text("utf-8")
        web_ids = re.findall(r'"(\w+)"', re.search(r"ROLE_IDS = \[([^\]]*)\]", web).group(1))
        self.assertEqual(go, list(ROLES))
        self.assertEqual(web_ids, list(ROLES))


def offline_app() -> core_api.App:
    api = core_api.WebApi()
    api.base_url = ""  # без модели: тест не ходит в сеть, даже если в .env есть ключ
    with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": ""}):
        for key in ("EB_CONFIDENCE_GATE", "EB_CONFIDENCE_THRESHOLD"):
            os.environ.pop(key, None)
        return core_api.App(api)


class RoleThroughCore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = offline_app()

    def ask(self, body: dict) -> tuple:
        seen = []

        def generate(messages, *a, **kw):
            seen.append("\n".join(m["content"] for m in messages))
            return "Поиск потерь рассчитан на электросетевые компании.", ""

        with mock.patch.object(self.app.bot, "generate", side_effect=generate):
            payload = self.app.chat({"messages": TURNS, **body}, lambda *a: None)
        return payload, seen

    def test_role_reaches_chat_prompt(self):
        payload, seen = self.ask({"mode": "chat", "role": "grid"})
        self.assertEqual(payload["role"], "grid")
        self.assertTrue(seen)
        self.assertIn("Собеседник, вероятно: электросетевая компания.", seen[0])

    def test_eval_copilot_and_bad_role_go_without_it(self):
        for body in ({"mode": "eval", "role": "grid"}, {"mode": "copilot", "role": "grid"},
                     {"mode": "chat", "role": "admin"}, {"mode": "chat", "role": ["grid"]}, {"mode": "chat"}):
            payload, seen = self.ask(body)
            self.assertEqual(payload["role"], "", body)
            self.assertNotIn(MARK, "\n".join(seen), body)

    def test_eval_prompt_is_the_same_with_and_without_role(self):
        _, with_role = self.ask({"mode": "eval", "role": "housing"})
        _, without = self.ask({"mode": "eval"})
        self.assertEqual(with_role, without)


if __name__ == "__main__":
    unittest.main()
