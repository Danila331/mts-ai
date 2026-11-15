"""Понятная деградация (T30): модель недоступна — клиент получает разделы базы, а не ошибку.

Модель — заглушка tests/mock_api.py (fail_chat: 503 на каждый вызов генерации). Режим eval и solution.py
остаются при прежнем запасном ответе.

    python -m unittest tests.test_degraded -v
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

from mock_api import MockApi  # noqa: E402

from energybot.pipeline import FALLBACK  # noqa: E402

QUESTION = [{"role": "user", "content": "Сколько будет стоить платформа учёта на 150 приборов?"}]
ENV = {"LLM_API_KEY": "test-key", "EB_USE_EMBEDDINGS": "0", "EB_USE_RERANKER": "0", "EB_INDEX_CACHE_DIR": "",
       "EB_CONFIDENCE_GATE": "0", "EB_STREAM": "1", "EB_PLAN": "0", "EB_REFINE": "0", "EB_ARCH": "v3",
       "EB_REQUEST_TIMEOUT": "5"}


def make_app(url: str, **extra) -> core_api.App:
    with mock.patch.dict(os.environ, {**ENV, "LLM_BASE_URL": url, **extra}):
        return core_api.App(core_api.WebApi())


def ask(app: core_api.App, mode: str = "chat") -> tuple:
    events = []
    payload = app.chat({"messages": QUESTION, "mode": mode}, lambda name, data: events.append((name, data)))
    return payload, events


class ModelDown(unittest.TestCase):
    def test_chat_returns_kb_sections(self):
        with MockApi(fail_chat=True) as model:
            payload, events = ask(make_app(model.url), "chat")
        self.assertEqual(payload["text"], core_api.DEGRADED_TEXT)
        self.assertTrue(payload["fallback"], "запасной ответ — кнопка заявки остаётся")
        degraded = payload["degraded"]
        self.assertEqual(degraded["reason"], "model_error")
        sections = degraded["sections"]
        self.assertTrue(2 <= len(sections) <= 3, sections)
        self.assertEqual(len({s["chunk_id"] for s in sections}), len(sections))
        for s in sections:
            self.assertEqual(set(s), {"chunk_id", "doc", "title", "path", "excerpt"})
            self.assertTrue(s["excerpt"].strip())
            self.assertLessEqual(len(s["excerpt"]), core_api.DEGRADED_EXCERPT + 1)
        self.assertEqual(payload["guard"]["degraded"], "model_error")
        self.assertNotIn("delta", [n for n, _ in events], "модель ничего не напечатала")

    def test_sections_are_real_kb_chunks(self):
        with MockApi(fail_chat=True) as model:
            app = make_app(model.url)
            payload, _ = ask(app, "chat")
        by_id = {c.id: c for c in app.bot.kb.chunks}
        for s in payload["degraded"]["sections"]:
            chunk = by_id[s["chunk_id"]]
            self.assertFalse(chunk.is_guard)
            self.assertIn(s["excerpt"].rstrip("…")[:40], " ".join(chunk.text.split()))

    def test_eval_mode_keeps_fallback(self):
        with MockApi(fail_chat=True) as model:
            payload, _ = ask(make_app(model.url), "eval")
        self.assertEqual(payload["text"], FALLBACK)
        self.assertNotIn("degraded", payload)

    def test_copilot_mode_keeps_fallback(self):
        with MockApi(fail_chat=True) as model:
            payload, _ = ask(make_app(model.url), "copilot")
        self.assertEqual(payload["text"], FALLBACK)
        self.assertNotIn("degraded", payload)

    def test_no_model_at_all(self):
        with mock.patch.dict(os.environ, {**ENV, "LLM_API_KEY": "", "LLM_BASE_URL": ""}):
            app = core_api.App(core_api.WebApi())
        payload, _ = ask(app, "chat")
        self.assertEqual(payload["degraded"]["reason"], "model_unconfigured")
        self.assertTrue(payload["degraded"]["sections"])

    def test_healthy_model_is_not_degraded(self):
        answer = "Ориентир — 25 000 руб в год за прибор. Сколько у вас объектов?"
        with MockApi(reject_template_kwargs=False, responder=lambda m: answer) as model:
            payload, _ = ask(make_app(model.url), "chat")
        self.assertNotIn("degraded", payload)
        self.assertFalse(payload["fallback"])

    def test_solution_entry_point_untouched(self):
        # solution.py и Consultant.answer(mode="eval") не знают про degraded.
        text = (ROOT / "solution.py").read_text(encoding="utf-8")
        self.assertNotIn("degraded", text)
        for path in (ROOT / "energybot").glob("*.py"):
            self.assertNotIn("DEGRADED_TEXT", path.read_text(encoding="utf-8"), path.name)


class SimplerTiers(unittest.TestCase):
    def test_tier_label_bm25_when_dense_and_reranker_off(self):
        with MockApi(fail_chat=True) as model:
            payload, _ = ask(make_app(model.url), "chat")
        retrieval = payload["retrieval"]
        self.assertEqual(retrieval["tier"], "bm25")
        self.assertEqual(retrieval["skipped"], [], "их не просили — это не деградация")

    def test_reranker_down_marks_skipped(self):
        answer = "Ориентир — 25 000 руб в год за прибор. Сколько у вас объектов?"
        with MockApi(reject_template_kwargs=False, responder=lambda m: answer) as model:
            app = make_app(model.url, EB_USE_RERANKER="1")
            with mock.patch.object(app.api, "rerank", side_effect=RuntimeError("503")):
                payload, _ = ask(app, "chat")
        self.assertNotIn("degraded", payload, "модель жива — ответ обычный, по простой ступени")
        self.assertEqual(payload["retrieval"]["skipped"], ["reranker"])
        self.assertEqual(payload["retrieval"]["tier"], "bm25")

    def test_reranker_works_label(self):
        answer = "Ориентир — 25 000 руб в год за прибор. Сколько у вас объектов?"
        with MockApi(reject_template_kwargs=False, responder=lambda m: answer) as model:
            payload, _ = ask(make_app(model.url, EB_USE_RERANKER="1"), "chat")
        self.assertEqual(payload["retrieval"]["tier"], "bm25 + реранкер")
        self.assertEqual(payload["retrieval"]["skipped"], [])


if __name__ == "__main__":
    unittest.main()
