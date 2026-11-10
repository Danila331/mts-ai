"""Проверки эксперимента EB_QUERY_REWRITE без внешнего API."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.llm import Api  # noqa: E402
from energybot.pipeline import Consultant, valid_search_query  # noqa: E402
from energybot.text import tokens  # noqa: E402
from mock_api import MockApi  # noqa: E402

KB_DIR = ROOT / "knowledge-base"
DIALOG = ("Пользователь: Мы электросетевая компания, ищем коммерческие потери.\n"
          "Ассистент: Какой архив данных есть?\nПользователь: Примерно за два года. Таких данных хватит?")
REWRITTEN = "поиск коммерческих потерь, архив за два года, требования к глубине и детализации данных"


class RetrieverStub:
    def __init__(self):
        self.calls = []

    def search_multi(self, queries, vectors, **kwargs):
        self.calls.append((queries, vectors, kwargs))
        return []

    def context(self, *args, **kwargs):
        return []


class QueryRewriteTest(unittest.TestCase):
    def _bot(self, mock):
        old = {k: os.environ.get(k) for k in ("LLM_BASE_URL", "LLM_API_KEY")}
        os.environ.update(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key")
        try:
            bot = Consultant(KB_DIR, api=Api())
        finally:
            for key, value in old.items():
                os.environ.pop(key) if value is None else os.environ.__setitem__(key, value)
        bot.retriever = RetrieverStub()
        bot.dense = True
        self.embed_calls = []

        def embed(texts):
            self.embed_calls.append(list(texts))
            return [[float(len(text))] for text in texts]

        bot.embed_queries = embed
        return bot

    def test_two_queries_and_exact_vectors(self):
        with MockApi(reject_template_kwargs=False) as mock:
            bot = self._bot(mock)
            with patch.dict(os.environ, {"EB_QUERY_REWRITE": "1"}, clear=False):
                bot.retrieve(parse(DIALOG), query_vec=[999], state={"search_query": REWRITTEN})
        lexical = search_queries(parse(DIALOG))[0]
        self.assertEqual(self.embed_calls, [[REWRITTEN, lexical]])
        queries, vectors, kwargs = bot.retriever.calls[0]
        self.assertEqual(queries, [REWRITTEN, lexical])
        self.assertNotEqual(vectors[0], [999])
        self.assertNotEqual(vectors[1], [999])
        self.assertEqual(kwargs["rerank_query"], REWRITTEN + "\n" + lexical)
        self.assertTrue(kwargs["rerank"])

    def test_flag_off_preserves_old_multi_query(self):
        with MockApi(reject_template_kwargs=False) as mock:
            bot = self._bot(mock)
            with patch.dict(os.environ, {"EB_QUERY_REWRITE": "0"}, clear=False):
                bot.retrieve(parse(DIALOG), query_vec=[999], state={"search_query": REWRITTEN})
        queries, vectors, kwargs = bot.retriever.calls[0]
        self.assertGreaterEqual(len(queries), 2)
        self.assertNotEqual(queries, ["Примерно за два года. Таких данных хватит?", REWRITTEN])
        self.assertEqual(vectors[1], [999])

    def test_same_or_empty_rewrite_falls_back(self):
        with MockApi(reject_template_kwargs=False) as mock:
            bot = self._bot(mock)
            last = "Примерно за два года. Таких данных хватит?"
            with patch.dict(os.environ, {"EB_QUERY_REWRITE": "1"}, clear=False):
                bot.retrieve(parse(DIALOG), state={"search_query": last})
                bot.retrieve(parse(DIALOG), state={"search_query": ""})
        self.assertEqual(len(bot.retriever.calls), 2)
        self.assertGreaterEqual(len(bot.retriever.calls[0][0]), 2)
        self.assertNotEqual(bot.retriever.calls[0][0], [last, last])

    def test_fast_mode_does_not_request_new_embeddings(self):
        with MockApi(reject_template_kwargs=False) as mock:
            bot = self._bot(mock)
            with patch.dict(os.environ, {"EB_QUERY_REWRITE": "1"}, clear=False):
                bot.retrieve(parse(DIALOG), query_vec=[999], fast=True, state={"search_query": REWRITTEN})
        self.assertEqual(self.embed_calls, [])
        self.assertFalse(bot.retriever.calls[0][2]["rerank"])

    def test_rewrite_without_embeddings_uses_two_bm25_queries(self):
        with MockApi(reject_template_kwargs=False) as mock:
            bot = self._bot(mock)
            bot.dense = False
            with patch.dict(os.environ, {"EB_QUERY_REWRITE": "1"}, clear=False):
                bot.retrieve(parse(DIALOG), state={"search_query": REWRITTEN})
        self.assertEqual(self.embed_calls, [])
        self.assertEqual(bot.retriever.calls[0][1], [None, None])

    def test_dialog_state_contains_rewrite_and_failure_fallback(self):
        payload = {"object": "сетевая компания", "goal": "потери", "known_data": ["два года"],
                   "constraints": [], "discussed_products": ["поиск коммерческих потерь"],
                   "last_question": "Таких данных хватит?", "missing_data": [], "search_query": REWRITTEN}
        with MockApi(reject_template_kwargs=False, responder=lambda messages: json.dumps(payload, ensure_ascii=False)) as mock:
            bot = self._bot(mock)
            state = bot.dialog_state(parse(DIALOG))
            self.assertEqual(state["search_query"], REWRITTEN)
        with MockApi(reject_template_kwargs=False, responder=lambda messages: "not json") as mock:
            bot = self._bot(mock)
            state = bot.dialog_state(parse(DIALOG))
            self.assertEqual(state["search_query"], "")

    def test_last_user_is_not_truncated_by_history_limit(self):
        payload = {"object": "", "goal": "", "known_data": [], "constraints": [],
                   "discussed_products": [], "last_question": "Последний вопрос полностью?",
                   "missing_data": [], "search_query": ""}
        dialog = "Пользователь: " + "старая история " * 3000 + "\nАссистент: Понял.\nПользователь: Последний вопрос полностью?"
        with MockApi(reject_template_kwargs=False, responder=lambda messages: json.dumps(payload, ensure_ascii=False)) as mock:
            bot = self._bot(mock)
            bot.dialog_state(parse(dialog))
            sent = mock.last_messages[1]["content"]
        self.assertIn("ПОСЛЕДНЯЯ РЕПЛИКА КЛИЕНТА (полностью):\nПоследний вопрос полностью?", sent)
        self.assertLess(len(sent), 7500)

    def test_installment_synonyms_do_not_need_llm(self):
        expanded = tokens("Можно оплачивать станцию частями?", expand=True)
        self.assertIn("рассрочк", expanded)
        self.assertIn("платеж", expanded)

    def test_validator_rejects_answer_prefix_and_same_query(self):
        self.assertEqual(valid_search_query({"search_query": "Ответ: да"}, "вопрос"), "")
        self.assertEqual(valid_search_query({"search_query": "один и тот же"}, "Один и тот же"), "")
        self.assertEqual(valid_search_query({"search_query": ""}, "вопрос"), "")


if __name__ == "__main__":
    unittest.main()
