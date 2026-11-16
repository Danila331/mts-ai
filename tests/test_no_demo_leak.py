"""Проверка, что демо-тексты не зашиты в строки генератора."""

from __future__ import annotations

import ast
import csv
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def words(text):
    return re.findall(r"[а-яa-z0-9]+", text.lower().replace("ё", "е"))


class DemoLeakTest(unittest.TestCase):
    def test_static_strings_do_not_copy_demo_passages(self):
        demo_ngrams = set()
        for filename, column in (("demo_questions.csv", "question"), ("demo_output.csv", "answer")):
            with (ROOT / filename).open(encoding="utf-8-sig", newline="") as source:
                for row in csv.DictReader(source):
                    tokens = words(row[column])
                    demo_ngrams.update(tuple(tokens[i:i + 5]) for i in range(len(tokens) - 4))

        for path in [*(ROOT / "energybot").glob("*.py"), ROOT / "solution.py"]:
            if path.name in {"gold_examples.py", "examples.py"}:
                continue  # эталоны зашиты намеренно для few-shot; совпадение исключается при выборе
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                    continue
                tokens = words(node.value)
                copied = next((tuple(tokens[i:i + 5]) for i in range(len(tokens) - 4)
                               if tuple(tokens[i:i + 5]) in demo_ngrams), None)
                self.assertIsNone(copied, f"{path.name}:{node.lineno}: {' '.join(copied or ())}")


if __name__ == "__main__":
    unittest.main()
