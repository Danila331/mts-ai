"""Офлайн-тесты стенда «Стресс-тест по персонам» (eval/personas.py): сценарии, метрики, прогон на заглушке.

    python -m unittest tests.test_personas -v
"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

import personas  # noqa: E402

from energybot.kb import KnowledgeBase  # noqa: E402

SCRIPT = ROOT / "eval" / "personas.py"


def run_script(*args: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "OPENAI_", "JUDGE_"))}
    env.pop("PYTHONPATH", None)
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=ROOT, env=env, capture_output=True, text=True,
                          timeout=300)


class ScenariosTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.items = personas.load_scenarios()

    def test_all_case_personas_covered(self):
        counts = {k: sum(s["persona"] == k for s in self.items) for k in personas.PERSONAS}
        self.assertTrue(all(n >= 3 for n in counts.values()), counts)
        self.assertTrue(all(len(personas.client_replies(s)) >= 3 for s in self.items))

    def test_no_demo_questions_copied(self):
        with open(ROOT / "demo_questions.csv", encoding="utf-8-sig", newline="") as f:
            demo = " ".join(" ".join(r["question"].split()) for r in csv.DictReader(f))
        for s in self.items:
            for reply in personas.client_replies(s):
                self.assertNotIn(" ".join(reply.split()), demo, s["id"])

    def test_only_test_personal_data(self):
        for s in self.items:
            for reply in personas.client_replies(s):
                for phone in re.findall(r"\+7[\d ()-]{10,}", reply):
                    self.assertEqual(phone.strip(), "+7 900 000-00-00", s["id"])

    def test_validation_catches_broken_scenario(self):
        bad = [{"id": "x", "persona": "кто-то", "start": "", "followups": [], "context_turn": 5, "lead_expected": 1}]
        self.assertEqual(len(personas.validate_scenarios(bad)), 4)


class MetricsTest(unittest.TestCase):
    def test_question_and_lead_heuristics(self):
        self.assertTrue(personas.asks_question("Сколько у вас приборов?"))
        self.assertFalse(personas.asks_question("Платформа это умеет."))
        self.assertTrue(personas.offers_lead("Могу передать ваш запрос специалисту."))
        self.assertTrue(personas.offers_lead("Оставьте контакты, и с вами свяжутся."))
        self.assertTrue(personas.offers_lead("Это покажет бесплатная предварительная оценка по данным объекта."))
        self.assertFalse(personas.offers_lead("Платформа собирает показания дистанционно."))

    def test_lead_timing(self):
        status = personas.lead_status
        self.assertEqual(status([False, True, True], 2, True)["status"], "timely")
        self.assertEqual(status([True, False, False], 2, True)["status"], "early")
        self.assertEqual(status([False, False], 1, True)["status"], "missing")
        self.assertEqual(status([False, False], 1, False)["status"], "none_ok")
        self.assertEqual(status([False, True], 1, False), {"status": "extra", "first_offer_turn": 2,
                                                            "context_turn": 1, "expected": False})

    def test_summary(self):
        turn = {"unknown_numbers": [], "asked_question": True, "fallback": False, "guard": {},
                "llm_calls": {"chat": 1, "embed": 1, "rerank": 1}}
        bad = dict(turn, unknown_numbers=["987"], asked_question=False, guard={"repaired": True},
                   llm_calls={"chat": 2, "embed": 1, "rerank": 1})
        dialogs = [{"turns": [turn, bad], "lead": {"status": "timely"}},
                   {"turns": [bad, turn], "lead": {"status": "missing"}}]
        s = personas.summarize(dialogs)
        self.assertEqual((s["turns"], s["clean_numbers_rate"], s["question_rate"]), (4, 0.5, 0.5))
        self.assertEqual((s["first_reply_question_rate"], s["lead_ok_rate"], s["guard_fired_rate"]), (0.5, 0.5, 0.5))
        self.assertEqual(s["llm_calls"], {"chat": 6, "embed": 4, "rerank": 4})
        self.assertIsNone(s["passport_fill"])

    def test_estimate_counts_turns(self):
        est = personas.estimate(personas.load_scenarios())
        turns = sum(len(personas.client_replies(s)) for s in personas.load_scenarios())
        self.assertEqual(est["client_turns"], turns)
        self.assertGreaterEqual(est["chat_calls_max"], est["chat_calls_min"])


class MockRunTest(unittest.TestCase):
    """Прогон скрипта на заглушке: JSON нужной схемы, метрики посчитаны, текстов базы в отчёте нет."""

    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            cls.proc = run_script("--mock", "--limit", "1", "--out", str(out))
            cls.raw = out.read_text(encoding="utf-8") if out.is_file() else ""
        cls.report = json.loads(cls.raw) if cls.raw else {}

    def test_runs_and_prints_real_run_hint(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr[-2000:])
        self.assertIn("--real", self.proc.stdout)
        self.assertIn("реплик клиента", self.proc.stdout)
        self.assertIn("source .env", self.proc.stdout)

    def test_report_schema(self):
        r = self.report
        self.assertEqual(r["schema"], personas.SCHEMA)
        self.assertTrue(r["mock"])
        self.assertEqual(r["config"]["mode"], "chat")
        self.assertEqual([p["persona"] for p in r["personas"]], list(personas.PERSONAS))
        self.assertEqual(len(r["dialogs"]), len(personas.PERSONAS))
        for p in r["personas"] + [r["totals"]]:
            for key in ("scenarios", "turns", "clean_numbers_rate", "question_rate", "lead", "lead_ok_rate",
                        "fallback_rate", "llm_calls"):
                self.assertIn(key, p)
            self.assertIsNone(p["passport_fill"])
        for d in r["dialogs"]:
            self.assertIn(d["lead"]["status"], ("timely", "early", "missing", "none_ok", "extra"))
            for t in d["turns"]:
                self.assertTrue(t["bot"].strip())
                for key in ("client", "asked_question", "lead_offer", "unknown_numbers", "guard", "sources",
                            "llm_calls"):
                    self.assertIn(key, t)

    def test_metrics_follow_mock_bot(self):
        """Заглушка спрашивает на 1-й реплике, выдумывает число на 2-й, зовёт специалиста с 3-й."""
        t = self.report["totals"]
        self.assertEqual(t["question_rate"], 1.0)
        self.assertEqual(t["clean_numbers_rate"], 1.0)  # выдуманное число убрала самопроверка ядра (verify)
        self.assertEqual(t["fallback_rate"], 0.0)
        self.assertEqual(t["lead"]["extra"], 1)  # менеджер МТС: заявка не ожидалась
        self.assertEqual(t["lead"]["timely"], 4)
        second = self.report["dialogs"][0]["turns"][1]
        # v28: число 987 ловит самопроверка до guard: в ответе его уже нет, guard молчит.
        self.assertNotIn("987", second["bot"])
        self.assertEqual(second["unknown_numbers"], [])
        self.assertEqual(second["guard"], {})
        # Реплика = тип вопроса + основной ответ; число в ответе добавляет самопроверку (второй черновик и сверку).
        self.assertGreaterEqual(second["llm_calls"]["chat"], 4)
        self.assertGreaterEqual(t["llm_calls"]["chat"], 2 * t["turns"] + 2 * len(self.report["dialogs"]))

    def test_no_knowledge_base_text(self):
        kb = KnowledgeBase.load(ROOT / "knowledge-base")
        for c in kb.chunks:
            text = " ".join(c.text.split())
            if len(text) >= 60:
                self.assertNotIn(text[:60], self.raw, c.id)

    def test_mock_report_is_not_published(self):
        before = personas.PUBLISHED.read_bytes() if personas.PUBLISHED.is_file() else None
        proc = run_script("--mock", "--limit", "1", "--publish")
        self.assertEqual(proc.returncode, 2)
        after = personas.PUBLISHED.read_bytes() if personas.PUBLISHED.is_file() else None
        self.assertEqual(before, after)


class PublishedReportTest(unittest.TestCase):
    def test_committed_report_is_real_or_absent(self):
        """Опубликованный отчёт (если он есть) — только настоящий прогон, не заглушка."""
        if not personas.PUBLISHED.is_file():
            self.skipTest("страница /lab убрана со стенда, отчёт не публикуется")
        data = json.loads(personas.PUBLISHED.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "dialogs" in data:
            self.assertEqual(data["schema"], personas.SCHEMA)
            self.assertIs(data["mock"], False)


if __name__ == "__main__":
    unittest.main()
