"""Опора ответа в отладке (core_api.attribute): числа клиента не считаются «числами без опоры»."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# core_api при импорте читает .env и ставит свои умолчания: окружение остальных тестов не трогаем.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)


def chunk(text: str):
    return SimpleNamespace(id="c1", doc="20-products/22-askue.md", path=["Платформа"], text=text,
                           search_text=lambda: text)


class AttributionTest(unittest.TestCase):
    KB = [chunk("Облачная платформа учёта подходит для любого количества приборов учёта.")]
    ANSWER = "Для 40 счётчиков на трёх складах подходит облачная платформа учёта."

    def test_number_from_client_is_not_flagged(self):
        cites = core_api.attribute(self.ANSWER, self.KB, "У нас три склада и около 40 счётчиков.")
        self.assertEqual(cites[0]["unsupported_numbers"], [])

    def test_number_nobody_said_is_flagged(self):
        cites = core_api.attribute(self.ANSWER, self.KB, "У нас три склада.")
        self.assertEqual(cites[0]["unsupported_numbers"], ["40"])


if __name__ == "__main__":
    unittest.main()
