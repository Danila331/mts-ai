"""Офлайн-тесты: нарезка базы, разбор диалогов, постобработка, полный прогон solution.py на заглушке API.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import csv
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.kb import KnowledgeBase, normalize_tables  # noqa: E402
from energybot.llm import strip_thinking  # noqa: E402
from energybot.pipeline import tidy  # noqa: E402
from mock_api import MockApi  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


class KnowledgeBaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb = KnowledgeBase.load(KB_DIR)

    def test_multiline_table_cells_are_merged(self):
        chunk = next(c for c in self.kb.chunks
                     if c.doc.endswith("01-numbers-and-indicators.md") and c.path == "Выход на оптовый рынок")
        self.assertIn("Значение: 750 кВт присоединённой мощности", chunk.text)
        self.assertNotIn("----", chunk.text)

    def test_simple_table(self):
        raw = "  Что          Точность\n  ------------ --------\n  Вода         более 90%\n\nТекст"
        self.assertIn("- Что: Вода; Точность: более 90%", normalize_tables(raw))

    def test_zip_and_dir_give_same_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "kb.zip"
            with zipfile.ZipFile(zpath, "w") as z:
                for p in KB_DIR.rglob("*.md"):
                    z.write(p, p.relative_to(KB_DIR).as_posix())
            self.assertEqual(KnowledgeBase.load(zpath).fingerprint, self.kb.fingerprint)

    def test_guards_present_for_products(self):
        for doc in ("20-products/23-solar.md", "20-products/22-askue.md", "20-products/24-losses.md"):
            paths = [g.path for g in self.kb.guards(doc)]
            self.assertIn("Чего утверждать нельзя", paths, doc)


class DialogTest(unittest.TestCase):
    def test_single_question(self):
        self.assertEqual(parse("Сколько стоит?"), [{"role": "user", "content": "Сколько стоит?"}])

    def test_dialog_roles_and_multiline(self):
        q = "Пользователь: У нас завод.\nАссистент: Какая мощность?\nПользователь: 800 кВт.\nХватит для опта?"
        turns = parse(q)
        self.assertEqual([t["role"] for t in turns], ["user", "assistant", "user"])
        self.assertEqual(turns[-1]["content"], "800 кВт. Хватит для опта?")
        lexical, semantic, last = search_queries(turns)
        self.assertIn("завод", lexical)
        self.assertIn("Какая мощность", semantic)

    def test_dialog_ending_with_assistant(self):
        turns = parse("Пользователь: Привет\nАссистент: Чем помочь?")
        self.assertEqual(turns[-1]["role"], "user")


class PostprocessTest(unittest.TestCase):
    def test_strip_thinking(self):
        self.assertEqual(strip_thinking("<think>a\nb</think>\nОтвет"), "Ответ")
        self.assertEqual(strip_thinking("<think>не закрыто"), "")

    def test_tidy_removes_markdown(self):
        self.assertEqual(tidy("Консультант: **Да**, можно:\n- раз\n- два\nВопрос?"), "Да, можно: раз два Вопрос?")


class SolutionEndToEndTest(unittest.TestCase):
    def _run(self, mock: MockApi, questions: list) -> tuple:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            with open(data / "questions.csv", "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f, quoting=csv.QUOTE_ALL)
                w.writerow(["id", "question"])
                w.writerows(questions)
            with zipfile.ZipFile(data / "knowledge-base.zip", "w") as z:
                for p in KB_DIR.rglob("*.md"):
                    z.write(p, p.relative_to(KB_DIR).as_posix())
            env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "OPENAI_", "JUDGE_"))}
            env.update(DATA_DIR=str(data), LLM_BASE_URL=mock.url, LLM_API_KEY="test-key", MAX_WORKERS="3")
            proc = subprocess.run([sys.executable, str(ROOT / "solution.py")], cwd=tmp, env=env,
                                  capture_output=True, text=True, timeout=300)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(Path(tmp) / "submission.csv", encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            return rows, proc.stderr

    def test_full_run_with_quirky_server(self):
        questions = [("7", "Можно ли поставить панели на шиферную крышу?"),
                     ("3", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт. Подойдёт?"),
                     ("10", "Сколько стоит платформа учёта?")]
        with MockApi(reject_template_kwargs=True) as mock:
            rows, log = self._run(mock, questions)
        self.assertEqual([r["id"] for r in rows], ["7", "3", "10"])
        for r in rows:
            self.assertEqual(r["answer"], "Да, это возможно: первый факт второй факт Какой у вас регион?")
        self.assertGreaterEqual(mock.calls["rejected"], 1)  # отказ от chat_template_kwargs обработан
        self.assertGreaterEqual(mock.calls["embeddings"], 1)
        self.assertGreaterEqual(mock.calls["rerank"], 1)
        roles = [m["role"] for m in mock.last_messages]
        self.assertEqual(roles[0], "system")
        self.assertIn("МАТЕРИАЛЫ", mock.last_messages[0]["content"])

    def test_dialog_history_is_passed_as_turns(self):
        with MockApi(reject_template_kwargs=False) as mock:
            self._run(mock, [("1", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт.")])
        self.assertEqual([m["role"] for m in mock.last_messages], ["system", "user", "assistant", "user"])

    def test_llm_outage_still_gives_valid_submission(self):
        with MockApi(fail_chat=True) as mock:
            rows, _ = self._run(mock, [("1", "Вопрос один?"), ("2", "Вопрос два?")])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("специалист" in r["answer"] for r in rows))


if __name__ == "__main__":
    unittest.main()
