"""Будущие офлайн-тесты новых механизмов качества. Не запускать до разрешения владельца."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.dialog import fallback_state, parse, retrieval_queries  # noqa: E402
from energybot.kb import Chunk  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402
from energybot.retrieval import Hit, Retriever  # noqa: E402


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)

    def chat(self, *args, **kwargs):
        return self.responses.pop(0)


class DialogMemoryTest(unittest.TestCase):
    def test_queries_cover_question_situation_and_aspect(self):
        turns = parse("Пользователь: У нас три склада.\nАссистент: Что нужно?\n"
                      "Пользователь: Автоматический учёт, телефон пока не готов дать.\n"
                      "Ассистент: Сколько приборов?\nПользователь: Сорок. Что нужно для оценки?")
        state = fallback_state(turns)
        queries = retrieval_queries(turns, state)
        self.assertEqual(len(queries), 3)
        self.assertIn("Сорок. Что нужно для оценки?", state["last_question"])
        self.assertTrue(state["constraints"])
        self.assertIn("облачная платформа учёта", state["discussed_products"])
        self.assertIn("следующего шага", queries[2])


class SlotContextTest(unittest.TestCase):
    def test_slots_reserve_limit_and_next_step(self):
        texts = [
            "Общий ответ", "Похожий общий ответ", "Как работает платформа",
            "Ограничения и условия", "Какие данные нужны для расчёта", "Дополнение",
        ]
        chunks = [Chunk(str(i), "doc.md", "Doc", text, text) for i, text in enumerate(texts)]
        ranked = [Hit(chunk, 1 - i * 0.01, "test") for i, chunk in enumerate(chunks)]
        selected = Retriever._slot_main(ranked, 5)
        self.assertEqual(len(selected), 5)
        self.assertIn(chunks[3], selected)
        self.assertIn(chunks[4], selected)


class EvidencePipelineTest(unittest.TestCase):
    def test_evidence_uses_original_ids_in_slot_order(self):
        chunks = [Chunk("a", "doc.md", "Doc", "Прямой ответ", "факт А"),
                  Chunk("b", "doc.md", "Doc", "Условие", "факт Б"),
                  Chunk("c", "doc.md", "Doc", "Следующий шаг", "факт В"),
                  Chunk("d", "doc.md", "Doc", "Лишнее", "не выбрано")]
        response = json.dumps({"direct": ["a"], "conditions": [], "next_step": ["c", "unknown"]}, ensure_ascii=False)
        bot = SimpleNamespace(api=FakeApi([response]))
        with patch.dict(os.environ, {"EB_COMPACT_EVIDENCE": "1"}, clear=False):
            evidence = Consultant.extract_evidence(bot, [], chunks)
        self.assertLess(evidence.index("факт А"), evidence.index("факт В"))
        self.assertNotIn("не выбрано", evidence)
        self.assertNotIn("факт Б", evidence)

    def test_empty_or_broken_evidence_selection_uses_fallback(self):
        chunks = [Chunk("a", "doc.md", "Doc", "Раздел", "текст")]
        bot = SimpleNamespace(api=FakeApi(["not json"]))
        self.assertEqual(Consultant.extract_evidence(bot, [], chunks), "")

    def test_candidate_judge_cannot_rewrite_answer(self):
        bot = SimpleNamespace(api=FakeApi(["Черновик Б", json.dumps({"choice": "B"})]))
        with patch.dict(os.environ, {"EB_CANDIDATE_SELECT": "1"}, clear=False):
            selected = Consultant.verify(bot, [], "Черновик А", ensemble=True)
        self.assertEqual(selected, "Черновик Б")

    def test_claim_guard_repairs_unsupported_sentence(self):
        labels = {"labels": ["SUPPORTED", "UNSUPPORTED"]}
        bot = SimpleNamespace(api=FakeApi([json.dumps(labels), "Подтверждённый ответ. Уточните объект?"]))
        with patch.dict(os.environ, {"EB_CLAIM_GUARD": "1"}, clear=False):
            text, guard = Consultant.check_claims(bot, "Факт из базы. Выдуманное обещание.", [], fast=False)
        self.assertEqual(text, "Подтверждённый ответ. Уточните объект?")
        self.assertTrue(guard["claims_repaired"])
        self.assertEqual(guard["unsupported_claims"], ["Выдуманное обещание."])


if __name__ == "__main__":
    unittest.main()
