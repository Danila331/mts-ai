"""Уверенность ответа и уточнение ниже порога (T12): scripts/core_api.py.

Без модели и без сети: Api ядра обнулён, генерация там, где она нужна, подменена детерминированной заглушкой.

    python -m unittest tests.test_confidence -v
"""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# core_api при импорте читает .env и ставит свои умолчания: окружение остальных тестов не трогаем.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

from energybot.pipeline import FALLBACK, Answer  # noqa: E402
from energybot.prompts import CLARIFY_SYSTEM, build_write_messages, system_prompt  # noqa: E402
from energybot.retrieval import Hit  # noqa: E402

QUESTION = [{"role": "user", "content": "Что нужно, чтобы подключить платформу учёта электроэнергии?"}]
GATE_ENV = ("EB_CONFIDENCE_GATE", "EB_CONFIDENCE_THRESHOLD")
UNREACHABLE = 1.01  # выше любой уверенности: ниже порога окажется любой вопрос


def offline_app() -> core_api.App:
    api = core_api.WebApi()
    api.base_url = ""  # без модели: тест не ходит в сеть, даже если в .env есть ключ
    with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": ""}):
        for key in GATE_ENV:
            os.environ.pop(key, None)
        return core_api.App(api)


class Recorder:
    """Считает обращения к поиску и к answer() ядра, не меняя их результата."""

    def __init__(self, app: core_api.App, answer=None):
        self.app, self.searches, self.answers = app, 0, []
        self.search, self.answer = app.bot.retriever.search, app.bot.answer

        def search(*a, **kw):
            self.searches += 1
            return self.search(*a, **kw)

        def answer_call(turns, mode="eval", **kw):
            self.answers.append(mode)
            return answer(turns, mode) if answer else self.answer(turns, mode=mode, **kw)

        app.bot.retriever.search, app.bot.answer = search, answer_call

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.app.bot.retriever.search = self.search
        del self.app.bot.answer  # снова метод класса


def stub_answer(turns, mode):
    return Answer("Для подключения платформы нужен перечень приборов учёта.", [], {"total": 0.0})


class ConfidenceMetric(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = offline_app()

    def test_retrieval_part_is_in_unit_interval(self):
        questions = [
            "Сколько стоит платформа учёта на 200 счётчиков?",
            "Вы ставите ветряки на базе отдыха?",
            "Подскажите тариф МТС для смартфона",
            "да",
            "?",
        ]
        for q in questions:
            core_api.TRACE.reset()
            self.app.bot.retrieve([{"role": "user", "content": q}])
            conf = core_api.TRACE.confidence
            if q == QUESTION[0]["content"]:
                self.assertEqual(conf["stage"], "rrf")
            self.assertGreaterEqual(conf["score"], 0.0, q)
            self.assertLessEqual(conf["score"], 1.0, q)
            # v28: BM25 не возвращает разделов без совпавших слов («да», «?») — выдача пуста, стадии нет.
            expected = "rrf" if core_api.TRACE.ranked else "none"
            self.assertEqual(conf["stage"], expected, "без реранкера — порядок RRF")
            if expected == "none":
                self.assertEqual(conf["score"], 0.0, q)
            self.assertEqual([p["key"] for p in conf["parts"]], ["lexical"])

    def test_more_question_words_in_kb_means_higher_retrieval(self):
        def score(q):
            core_api.TRACE.reset()
            self.app.bot.retrieve([{"role": "user", "content": q}])
            return core_api.TRACE.confidence["score"]

        self.assertGreater(score(QUESTION[0]["content"]), score("Напиши скрипт на Python для выгрузки в Excel"))

    def test_reranker_score_is_blended_and_clipped(self):
        chunk = self.app.bot.kb.chunks[0]
        terms = core_api.question_terms([{"role": "user", "content": "платформа"}])
        vocab = lambda c: terms  # noqa: E731 — все слова вопроса в разделе: лексическая часть = 1
        turns = [{"role": "user", "content": "платформа"}]
        for raw, expected in ((0.8, 0.9), (7.0, 1.0), (float("-inf"), 0.5)):
            conf = core_api.retrieval_confidence(turns, [Hit(chunk, raw, "rerank")], dict.fromkeys(terms, 1.0), vocab)
            self.assertEqual(conf["stage"], "rerank")
            self.assertAlmostEqual(conf["score"], expected, places=3)

    def test_support_part_and_total(self):
        cites = [
            {"question": False, "support": [{"id": "a"}], "unsupported_numbers": []},
            {"question": False, "support": [{"id": "a"}], "unsupported_numbers": ["99"]},
            {"question": False, "support": [], "unsupported_numbers": []},
            {"question": True, "support": [], "unsupported_numbers": []},
        ]
        support = core_api.support_confidence(cites)
        self.assertEqual((support["grounded"], support["claims"]), (1, 3))
        self.assertIsNone(core_api.support_confidence(cites[3:]), "только вопрос клиенту — опору считать не по чему")
        retrieval = {"score": 0.5, "stage": "rrf", "parts": [{"key": "lexical", "value": 0.5}]}
        for s in (None, {"score": 0.0, "grounded": 0, "claims": 2}, {"score": 1.0, "grounded": 2, "claims": 2}):
            conf = core_api.answer_confidence(retrieval, s, 0.16, gate=False, gated=False)
            self.assertTrue(0.0 <= conf["score"] <= 1.0)
            self.assertEqual(conf["retrieval"], 0.5)
            self.assertIn("explain", conf)
        self.assertEqual(core_api.answer_confidence(retrieval, {"score": 1.0, "grounded": 2, "claims": 2},
                                                    0.16, False, False)["score"], 0.75)

    def test_answer_event_carries_confidence(self):
        with Recorder(self.app, stub_answer):
            payload = self.app.chat({"messages": QUESTION, "mode": "chat"}, lambda *a: None)
        conf = payload["confidence"]
        self.assertTrue(set(conf) >= {"score", "threshold", "retrieval", "support", "parts", "gated"})
        self.assertTrue(0.0 <= conf["score"] <= 1.0)
        self.assertIsNotNone(conf["support"], "у ответа по существу есть опора")
        self.assertFalse(conf["gated"])
        self.assertEqual(payload["route"], "answer")


class ConfidenceGate(unittest.TestCase):
    def setUp(self):
        self.app = offline_app()

    def ask(self, mode: str, answer=stub_answer) -> tuple:
        with Recorder(self.app, answer) as rec:
            payload = self.app.chat({"messages": QUESTION, "mode": mode}, lambda *a: None)
        return payload, rec

    def test_gate_is_off_by_default(self):
        self.assertFalse(self.app.gate)
        self.assertEqual(self.app.threshold, core_api.CONFIDENCE_THRESHOLD)
        self.app.threshold = UNREACHABLE  # даже с недостижимым порогом без флага ответ обычный
        payload, rec = self.ask("chat")
        self.assertEqual(payload["route"], "answer")
        self.assertEqual(rec.answers, ["chat"])
        self.assertFalse(payload["confidence"]["gate"])

    def test_flag_and_threshold_from_env(self):
        with mock.patch.dict(os.environ, {"EB_CONFIDENCE_GATE": "1", "EB_CONFIDENCE_THRESHOLD": "0.4",
                                          "EB_INDEX_CACHE_DIR": ""}):
            app = core_api.App(self.app.api)
        self.assertTrue(app.gate)
        self.assertEqual(app.threshold, 0.4)

    def test_eval_and_copilot_answer_as_before_with_gate_on(self):
        # Режим автопроверки (и копилот) не меняется ни при каких флагах: ни поиска заранее, ни уточнения.
        self.app.gate, self.app.threshold = True, UNREACHABLE
        for mode in ("eval", "copilot"):
            payload, rec = self.ask(mode)
            self.assertEqual(payload["route"], "answer", mode)
            self.assertEqual(rec.answers, [mode])
            self.assertEqual(payload["text"], stub_answer(QUESTION, mode).text)
            self.assertFalse(payload["confidence"]["gate"], mode)
            self.assertFalse(payload["confidence"]["gated"], mode)

    def test_eval_without_model_is_the_same_fallback_with_gate_on_and_off(self):
        # Настоящий answer() ядра без модели: тот же запасной ответ при выключенном и включённом гейте.
        texts = []
        for gate in (False, True):
            self.app.gate, self.app.threshold = gate, UNREACHABLE
            with mock.patch.object(self.app.bot.api, "chat", side_effect=RuntimeError("нет модели")):
                payload, rec = self.ask("eval", answer=None)
            texts.append((payload["text"], payload["fallback"], payload["route"], rec.searches))
        self.assertEqual(texts[0], texts[1])
        # v28: при сбое модели ядро отдаёт выдержку из базы (extractive), а FALLBACK — только если выдержки нет.
        self.assertEqual(texts[0][1:3], (True, "answer"))
        self.assertTrue(texts[0][0] and texts[0][0].endswith("подскажет специалист."))

    def test_chat_below_threshold_asks_to_clarify_without_answering(self):
        self.app.gate, self.app.threshold = True, UNREACHABLE

        def must_not_answer(turns, mode):
            raise AssertionError("ниже порога answer() не вызывается")

        payload, rec = self.ask("chat", answer=must_not_answer)
        self.assertEqual(payload["route"], "clarify")
        self.assertEqual(rec.answers, [])
        self.assertEqual(rec.searches, 1, "решение — по поиску до генерации")
        self.assertTrue(payload["text"].startswith(core_api.CLARIFY_LEAD))
        self.assertTrue(payload["text"].endswith("?"))
        self.assertNotEqual(payload["text"], FALLBACK)
        self.assertFalse(payload["fallback"])
        self.assertEqual(payload["llm_calls"], [], "без модели — вопрос по умолчанию")
        conf = payload["confidence"]
        self.assertTrue(conf["gate"] and conf["gated"])
        self.assertIsNone(conf["support"])
        self.assertLess(conf["retrieval"], conf["threshold"])

    def test_chat_above_threshold_reuses_prefetched_search(self):
        self.app.gate, self.app.threshold = True, 0.0
        with mock.patch.object(self.app.bot.api, "chat",
                               return_value="Для подключения платформы нужен перечень приборов учёта."):
            payload, rec = self.ask("chat", answer=None)
        self.assertEqual(payload["route"], "answer")
        self.assertEqual(rec.answers, ["chat"])
        self.assertEqual(rec.searches, 1, "answer() берёт выдачу prefetch, а не ищет второй раз")
        self.assertTrue(payload["confidence"]["gate"])
        self.assertFalse(payload["confidence"]["gated"])
        self.assertIsNotNone(payload["retrieval"])


class ClarifyText(unittest.TestCase):
    def test_question_from_model_output(self):
        turns = [{"role": "user", "content": "Нужна станция на 50 кВт"}]
        self.assertEqual(core_api.clarify_question("Понял. Какой у вас объект и регион?", turns),
                         "Какой у вас объект и регион?")
        self.assertEqual(core_api.clarify_question("Это для станции на 50 кВт?", turns), "Это для станции на 50 кВт?")
        self.assertEqual(core_api.clarify_question("Стоимость от 120 000 руб. Подходит?", turns), "Подходит?")
        self.assertEqual(core_api.clarify_question("Окупится за 3 года?", turns), "", "число не из диалога")
        self.assertEqual(core_api.clarify_question("Уточню у специалиста.", turns), "", "нет вопроса")

    def test_clarify_prompt_is_not_in_answer_prompts(self):
        # Автопроверка собирает промпт через system_prompt / build_write_messages: блок уточнения туда не попадает.
        for mode in ("eval", "chat", "copilot"):
            self.assertNotIn(CLARIFY_SYSTEM[:60], system_prompt("материалы", mode), mode)
            messages = build_write_messages("материалы", QUESTION, "черновик", mode)
            self.assertNotIn(CLARIFY_SYSTEM[:60], "\n".join(m["content"] for m in messages), mode)

    def test_submission_code_does_not_read_the_gate(self):
        # solution.py и общее ядро energybot/ не знают о гейте — он живёт только в scripts/core_api.py.
        files = [ROOT / "solution.py", *sorted((ROOT / "energybot").glob("*.py"))]
        for path in files:
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"""env\w*\(\s*["']EB_CONFIDENCE""", text), path.name)
            self.assertIsNone(re.search(r"^\s*(?:from|import)\s+\S*core_api", text, re.M), path.name)


if __name__ == "__main__":
    unittest.main()
