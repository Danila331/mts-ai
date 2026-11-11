"""Офлайн-тесты веб-прототипа: сессии, идемпотентность ходов, заявка, изоляция диалогов.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402
from mock_api import MockApi  # noqa: E402

from energybot.llm import Api  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402
from webapp.app import create_app  # noqa: E402
from webapp.db import Store  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


class WebAppTest(unittest.TestCase):
    def setUp(self):
        self.mock = MockApi(reject_template_kwargs=False)
        self.mock.thread.start()
        old = {k: os.environ.get(k) for k in ("LLM_BASE_URL", "LLM_API_KEY")}
        os.environ.update(LLM_BASE_URL=self.mock.url, LLM_API_KEY="test-key")
        self._restore = old
        self.tmp = tempfile.TemporaryDirectory()
        consultant = Consultant(KB_DIR, api=Api())
        self.store = Store(Path(self.tmp.name) / "test.sqlite3")
        self.client = TestClient(create_app(consultant, self.store))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()
        self.mock.server.shutdown()
        for k, v in self._restore.items():
            os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)

    def chat(self, sid: str, request_id: str, message: str):
        return self.client.post("/api/chat", json={
            "session_id": sid, "request_id": request_id, "message": message})

    def test_full_path_from_question_to_lead(self):
        sid = self.client.post("/api/session").json()["session_id"]

        r = self.chat(sid, "req-1", "У нас СНТ, нужно удалённо отключать неплательщиков. Что подойдёт?")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertTrue(data["text"])
        self.assertIn(data["action"], ("answer", "answer_clarify", "specialist", "boundary"))
        self.assertGreater(data["timings_ms"]["total"], 0)
        self.assertTrue(data["sources"])

        # История видна и влияет на контекст следующего хода.
        h = self.client.get(f"/api/history/{sid}").json()
        self.assertEqual(len(h["turns"]), 1)
        r2 = self.chat(sid, "req-2", "А сколько это стоит?")
        self.assertEqual(r2.status_code, 200)
        all_content = " ".join(m["content"] for m in self.mock.last_messages)
        self.assertIn("сколько это стоит", all_content)
        self.assertIn("неплательщиков", all_content)

        # Заявка: форма отдельно от промпта, резюме через модель, один раз на отправку.
        lead = self.client.post("/api/lead", json={
            "session_id": sid, "request_id": "lead-1",
            "name": "Тестов Тест Тестович", "phone": "+7 900 000-00-00", "company": "СНТ Тест"})
        self.assertEqual(lead.status_code, 200, lead.text)
        body = lead.json()
        self.assertEqual(body["lead_id"], 1)
        self.assertFalse(body["duplicated"])
        self.assertTrue(body["summary"])

        # Повторная отправка формы с тем же request_id — та же заявка, новой нет.
        again = self.client.post("/api/lead", json={
            "session_id": sid, "request_id": "lead-1",
            "name": "Тестов Тест Тестович", "phone": "+7 900 000-00-00", "company": "СНТ Тест"})
        self.assertTrue(again.json()["duplicated"])
        # Вторая заявка в той же сессии запрещена.
        other = self.client.post("/api/lead", json={
            "session_id": sid, "request_id": "lead-2",
            "name": "Тестов Тест", "phone": "+79000000000", "company": "СНТ Тест"})
        self.assertEqual(other.status_code, 409)

    def test_chat_is_idempotent_by_request_id(self):
        sid = self.client.post("/api/session").json()["session_id"]
        first = self.chat(sid, "same-req", "Сколько стоит платформа учёта?").json()
        after_first = self.mock.calls["chat"]
        second = self.chat(sid, "same-req", "Сколько стоит платформа учёта?").json()
        self.assertEqual(first["text"], second["text"])
        self.assertEqual(self.mock.calls["chat"], after_first)  # повтор не вызывает модель

    def test_new_dialog_resets_context_but_keeps_history(self):
        s1 = self.client.post("/api/session").json()["session_id"]
        self.chat(s1, "req-a", "Нужны солнечные панели для завода.")
        self.client.post(f"/api/session/{s1}/close")

        # Закрытая сессия не принимает реплики.
        self.assertEqual(self.chat(s1, "req-b", "ещё вопрос").status_code, 409)

        s2 = self.client.post("/api/session").json()["session_id"]
        self.assertNotEqual(s1, s2)
        self.chat(s2, "req-c", "Расскажите про тарифы.")
        self.assertNotIn("солнечные панели",
                         " ".join(m["content"] for m in self.mock.last_messages if m["role"] == "user"))

        # История первой сессии сохранена для проверки.
        h1 = self.client.get(f"/api/history/{s1}").json()
        self.assertEqual(len(h1["turns"]), 1)

    def test_validation_and_debug_overview(self):
        sid = self.client.post("/api/session").json()["session_id"]
        bad = self.client.post("/api/lead", json={
            "session_id": sid, "request_id": "lead-x", "name": "Т", "phone": "abc", "company": "С"})
        self.assertEqual(bad.status_code, 422)
        self.chat(sid, "req-9", "Что такое АСКУЭ?")
        overview = self.client.get("/api/debug/overview").json()
        self.assertEqual(len(overview["sessions"]), 1)
        self.assertEqual(len(overview["sessions"][0]["turns"]), 1)
        turn = overview["sessions"][0]["turns"][0]
        self.assertEqual(turn["status"], "done")
        self.assertIn("total", turn["timings"])

    def test_llm_outage_gives_503_and_allows_retry(self):
        self.mock.fail_chat = True
        sid = self.client.post("/api/session").json()["session_id"]
        r = self.chat(sid, "req-err", "Сколько стоит платформа?")
        self.assertEqual(r.status_code, 503)
        # В истории сбойный ход не считается ответом бота.
        self.assertEqual(self.client.get(f"/api/history/{sid}").json()["turns"], [])
        # Повтор с тем же request_id после сбоя разрешён.
        self.mock.fail_chat = False
        ok = self.chat(sid, "req-err", "Сколько стоит платформа?")
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(ok.json()["text"])


if __name__ == "__main__":
    unittest.main()
