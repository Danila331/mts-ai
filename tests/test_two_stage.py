"""Проверки двухстадийной генерации и исключения текущего демо-примера."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from energybot.dialog import parse
from energybot.kb import Chunk
from energybot.pipeline import Consultant
from energybot.prompts import ORGANIZER_EXAMPLES, build_write_messages, filter_examples
from energybot.retrieval import Hit


class TwoStageTest(unittest.TestCase):
    def setUp(self):
        api = Mock(configured=False, use_embeddings=False, can_rerank=False)
        self.bot = Consultant(Path(__file__).resolve().parents[1] / "knowledge-base", api=api)
        chunk = Chunk("test", "test.md", "Платформа", "Что это",
                      "Платформа собирает данные приборов учёта.")
        self.bot.retrieve = Mock(return_value=([Hit(chunk, 0.9, "rerank")], [chunk]))
        self.env = patch.dict("os.environ", {
            "EB_TWO_STAGE": "1", "EB_VERIFY": "0", "EB_SLOTS": "0", "EB_INTENT": "0",
            "EB_CALC": "0", "EB_AMBIGUITY": "0", "EB_FACTS_COMPOSE": "0",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_two_calls_and_verify_receives_write(self):
        self.bot.api.chat.side_effect = ["Основа по базе", "Платформа собирает данные."]
        with patch.dict("os.environ", {"EB_VERIFY": "1", "EB_VERIFY_SCORE": "1"}):
            self.bot.verify = Mock(side_effect=lambda messages, text, ensemble: text)
            answer = self.bot.answer("Что делает платформа?")
        self.assertEqual((answer.draft, answer.write, answer.text),
                         ("Основа по базе", "Платформа собирает данные.", "Платформа собирает данные."))
        self.assertEqual(self.bot.verify.call_args.args[1], answer.write)
        self.assertEqual(self.bot.api.chat.call_count, 2)

    def test_draft_gets_top_chunks_and_write_keeps_full_context(self):
        hits, chunks = self.bot.retrieve()
        extra = Chunk("extra", "extra.md", "Граница", "Условие", "Условия подключения проверяют отдельно.")
        self.bot.retrieve.return_value = hits, chunks + [extra]
        self.bot.api.chat.side_effect = ["Основа по базе", "Платформа собирает данные."]
        self.bot.answer("Что делает платформа?")
        draft_messages, write_messages = [call.args[0] for call in self.bot.api.chat.call_args_list]
        self.assertIn(chunks[0].render(), draft_messages[1]["content"])
        self.assertNotIn(extra.render(), draft_messages[1]["content"])
        self.assertIn(extra.render(), write_messages[0]["content"])

    def test_failed_draft_uses_one_stage(self):
        self.bot.api.chat.side_effect = [RuntimeError("нет черновика"), "Платформа собирает данные."]
        answer = self.bot.answer("Что делает платформа?")
        self.assertEqual(answer.text, "Платформа собирает данные.")
        self.assertEqual(answer.draft, "")
        self.assertEqual(self.bot.api.chat.call_count, 2)

    def test_failed_write_uses_one_stage(self):
        self.bot.api.chat.side_effect = ["Основа по базе", RuntimeError("нет ответа"), "Платформа собирает данные."]
        answer = self.bot.answer("Что делает платформа?")
        self.assertEqual(answer.text, "Платформа собирает данные.")
        self.assertEqual(answer.draft, "Основа по базе")
        self.assertEqual(answer.write, "")
        self.assertEqual(self.bot.api.chat.call_count, 3)

    def test_fast_and_disabled_skip_draft(self):
        for fast, enabled in ((True, "1"), (False, "0")):
            with self.subTest(fast=fast, enabled=enabled), patch.dict("os.environ", {"EB_TWO_STAGE": enabled}):
                self.bot.api.chat.reset_mock()
                self.bot.api.chat.side_effect = None
                self.bot.api.chat.return_value = "Платформа собирает данные."
                answer = self.bot.answer("Что делает платформа?", fast=fast)
                self.assertEqual(answer.draft, "")
                self.assertEqual(self.bot.api.chat.call_count, 1)

    def test_leave_one_out_for_every_demo_and_dialog_turn(self):
        for question, answer in ORGANIZER_EXAMPLES:
            with self.subTest(question=question[:60]):
                turns = parse(question)
                self.assertNotIn((question, answer), filter_examples(ORGANIZER_EXAMPLES, turns))
                self.assertNotIn(answer, build_write_messages("материалы", turns, "черновик")[0]["content"])
                if len(turns) > 1:
                    self.assertNotIn((question, answer), filter_examples(ORGANIZER_EXAMPLES, [turns[-1]]))


if __name__ == "__main__":
    unittest.main()
