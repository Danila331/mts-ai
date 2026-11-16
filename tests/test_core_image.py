"""Образ ядра (core/Dockerfile) копирует scripts/ по списку: каждый локальный модуль, который импортирует
core_api.py, должен быть в этом списке. Иначе ядро в контейнере падает при старте с ModuleNotFoundError — так
и было: модули чата (callback_promise, honest_no, logmask, quick_replies) не попали в образ, это поймал только
сквозной прогон CI в docker compose."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CoreImage(unittest.TestCase):
    def test_every_local_module_of_core_api_is_copied(self):
        source = (ROOT / "scripts/core_api.py").read_text(encoding="utf-8")
        imported = set(re.findall(r"^(?:import|from) ([a-z_]+)\b", source, re.M))
        local = {m for m in imported if (ROOT / "scripts" / f"{m}.py").exists()}
        self.assertTrue(local, "core_api.py импортирует модули из scripts/")
        dockerfile = (ROOT / "core/Dockerfile").read_text(encoding="utf-8")
        for module in sorted(local):
            self.assertIn(f"scripts/{module}.py", dockerfile, f"{module}.py не копируется в образ ядра")


if __name__ == "__main__":
    unittest.main()
