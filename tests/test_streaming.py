"""Потоковая выдача ответа (T13): scripts/core_api.py шлёт delta только в веб-режиме.

Модель — заглушка tests/mock_api.py с поддержкой "stream": true; сеть дальше петли не нужна.

    python -m unittest tests.test_streaming -v
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

# core_api при импорте читает .env и ставит свои умолчания: окружение остальных тестов не трогаем.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

from mock_api import MockApi  # noqa: E402

from energybot.llm import Api  # noqa: E402
from energybot.pipeline import Consultant, tidy  # noqa: E402

KB_DIR = ROOT / "knowledge-base"
QUESTION = [{"role": "user", "content": "Сколько будет стоить платформа учёта на 150 приборов?"}]
GOOD = "Ориентир — 25 000 руб в год за прибор, на объёмных внедрениях стоимость считается отдельно. Сколько у вас объектов?"
BAD = "Ориентир — 25 000 руб в год за прибор. Итого проект обойдётся в 3 750 000 рублей. Сколько у вас объектов?"
# Без модели, без векторов и реранкера: поиск — BM25, модель — только генерация ответа.
ENV = {"LLM_API_KEY": "test-key", "EB_USE_EMBEDDINGS": "0", "EB_USE_RERANKER": "0", "EB_INDEX_CACHE_DIR": "",
       "EB_CONFIDENCE_GATE": "0", "EB_STREAM": "1", "EB_PLAN": "0", "EB_REFINE": "0", "EB_ARCH": "v3"}


def make_app(url: str, **extra) -> core_api.App:
    with mock.patch.dict(os.environ, {**ENV, "LLM_BASE_URL": url, **extra}):
        return core_api.App(core_api.WebApi())


def ask(app: core_api.App, mode: str = "chat", **body) -> tuple:
    events = []
    # Вопрос о цене — триггер предложения менеджера (scripts/handoff.py); здесь проверяется потоковая выдача,
    # поэтому заявка «уже есть»: к тексту ответа ничего не дописывается.
    payload = app.chat({"messages": QUESTION, "mode": mode, "has_lead": True, **body}, lambda name, data: events.append((name, data)))
    deltas = [data["text"] for name, data in events if name == "delta"]
    return payload, deltas, [name for name, _ in events]


class CoreStreaming(unittest.TestCase):
    def test_chat_streams_main_answer(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: GOOD) as model:
            app = make_app(model.url)
            payload, deltas, names = ask(app, "chat")
            streams = model.calls["stream"]
        self.assertGreater(len(deltas), 3, "ответ печатается кусками")
        self.assertEqual("".join(deltas), GOOD)
        self.assertLess(names.index("stage"), names.index("delta"), "дельты — после начала генерации")
        self.assertEqual(payload["text"], GOOD)
        self.assertTrue(payload["streamed"])
        self.assertFalse(payload["revised"], "guard не трогал ответ — метки нет")
        self.assertEqual(streams, 1)

    def test_eval_mode_never_streams(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: GOOD) as model:
            app = make_app(model.url)
            payload, deltas, _ = ask(app, "eval")
            streams = model.calls["stream"]
        self.assertEqual((deltas, streams), ([], 0))
        self.assertEqual(payload["text"], GOOD)
        self.assertFalse(payload["streamed"] or payload["revised"])

    def test_submission_client_never_streams(self):
        # solution.py ходит в модель через Api и Consultant из energybot/ — там потока нет вовсе.
        with MockApi(reject_template_kwargs=False, responder=lambda m: GOOD) as model, \
                mock.patch.dict(os.environ, {**ENV, "LLM_BASE_URL": model.url}):
            text = Consultant(KB_DIR, api=Api()).answer(QUESTION, mode="eval").text
            streams = model.calls["stream"]
        self.assertEqual((text, streams), (GOOD, 0))

    def test_switches_off(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: GOOD) as model:
            _, deltas, _ = ask(make_app(model.url), "chat", stream=False)
            self.assertEqual(deltas, [], "запрос с stream: false")
            _, deltas, _ = ask(make_app(model.url, EB_STREAM="0"), "chat")
            self.assertEqual(deltas, [], "EB_STREAM=0")
            self.assertEqual(model.calls["stream"], 0)

    def test_guard_rewrite_replaces_streamed_text(self):
        # Модель выдумала число: напечатано как есть. В v28 подозрительные числа сначала ловит самопроверка
        # (verify: второй черновик + сверка) — финальный текст другой, чем напечатанный.
        def responder(messages):
            return GOOD if messages[-1]["content"].startswith("[Служебная") else BAD

        with MockApi(reject_template_kwargs=False, responder=responder) as model:
            payload, deltas, _ = ask(make_app(model.url), "chat")
            streams = model.calls["stream"]
        self.assertEqual("".join(deltas), BAD)
        self.assertEqual(payload["text"], GOOD, "финальный answer главнее дельт")
        self.assertTrue(payload["streamed"] and payload["revised"])
        self.assertEqual(streams, 1, "самопроверка и второй черновик потоком не идут")

    def test_number_repair_replaces_streamed_text(self):
        # Без самопроверки (EB_VERIFY=0) те же выдуманные числа ловит check(): перезапрос с правкой.
        def responder(messages):
            return GOOD if messages[-1]["content"].startswith("[Служебная") else BAD

        with MockApi(reject_template_kwargs=False, responder=responder) as model:
            app = make_app(model.url)
            with mock.patch.dict(os.environ, {"EB_VERIFY": "0"}):
                payload, deltas, _ = ask(app, "chat")
            streams = model.calls["stream"]
        self.assertEqual("".join(deltas), BAD)
        self.assertEqual(payload["text"], GOOD)
        self.assertTrue(payload["streamed"] and payload["revised"])
        self.assertTrue(payload["guard"]["repaired"])
        self.assertEqual(streams, 1, "перезапрос проверки потоком не идёт")

    def test_thinking_is_not_streamed(self):
        answer = "<think>рассуждаю про 3 750 000</think>\n" + GOOD
        with MockApi(reject_template_kwargs=True, responder=lambda m: answer) as model:
            payload, deltas, _ = ask(make_app(model.url), "chat")
            streams = model.calls["stream"]
        self.assertEqual("".join(deltas), GOOD)
        self.assertNotIn("рассуждаю", "".join(deltas))
        self.assertEqual(payload["text"], GOOD)
        self.assertFalse(payload["revised"])
        self.assertEqual(streams, 1, "после отказа от chat_template_kwargs — снова потоком, но один раз")

    def test_server_without_streams_answers_as_before(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: GOOD, stream_supported=False) as model:
            payload, deltas, _ = ask(make_app(model.url), "chat")
        self.assertEqual((deltas, payload["text"], payload["streamed"]), ([], GOOD, False))

    def test_fallback_without_model_has_no_deltas(self):
        app = make_app("")
        payload, deltas, _ = ask(app, "chat")
        self.assertEqual(deltas, [])
        # T30: в чате без модели клиент получает разделы базы; прежний FALLBACK остаётся в eval (test_degraded).
        self.assertEqual(payload["text"], core_api.DEGRADED_TEXT)
        self.assertTrue(payload["fallback"] and payload["degraded"]["sections"])
        self.assertFalse(payload["streamed"] or payload["revised"])

    def test_broken_model_falls_back_without_deltas(self):
        with MockApi(fail_chat=True) as model:
            payload, deltas, _ = ask(make_app(model.url, EB_REQUEST_TIMEOUT="5"), "chat")
        self.assertEqual(deltas, [])
        self.assertTrue(payload["fallback"])


class VisiblePrefix(unittest.TestCase):
    def test_rules_match_strip_thinking(self):
        vp = core_api.visible_prefix
        self.assertEqual(vp("Да, можно", False), "Да, можно")
        self.assertEqual(vp("<think>про себя", False), "")
        self.assertEqual(vp("<think>про себя</think>\n\nДа", False), "Да")
        self.assertEqual(vp("Ответ <", False), "Ответ ", "начало метки ждёт следующего куска")
        self.assertEqual(vp("Ответ </thi", False), "Ответ ")
        self.assertEqual(vp("Ответ < 5 кВт", False), "Ответ < 5 кВт")
        self.assertEqual(vp("думаю без открывающей метки", True), "", "размышления запрошены — ждём </think>")
        self.assertEqual(vp("думаю</think>Ответ", True), "Ответ")

    def test_sink_stops_when_visible_text_diverges(self):
        sent = []
        core_api.TRACE.reset(lambda name, data: sent.append(data["text"]))
        try:
            sink = core_api.DeltaSink(think=False)
            for piece in ("Черновик", " ответа", "</think>Настоящий ответ"):
                sink.feed(piece)
            sink.close()
            self.assertEqual(sent, ["Черновик", " ответа"])
            self.assertTrue(sink.broken)
            self.assertNotEqual(tidy(core_api.TRACE.streamed), "Настоящий ответ")
        finally:
            core_api.TRACE.reset()


if __name__ == "__main__":
    unittest.main()
