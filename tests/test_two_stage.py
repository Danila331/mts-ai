"""Проверки двухстадийной генерации и исключения текущего демо-примера."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from energybot.dialog import parse
from energybot.kb import Chunk
from energybot.pipeline import Consultant
from energybot.prompts import build_write_messages, filter_examples, static_example_pairs
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

    def test_single_stage_does_not_pass_other_customer_examples(self):
        self.bot.api.chat.return_value = "Платформа собирает данные."
        with patch.dict("os.environ", {"EB_TWO_STAGE": "0"}):
            self.bot.answer("Что делает платформа?")
        messages = self.bot.api.chat.call_args.args[0]
        self.assertEqual([message["role"] for message in messages], ["system", "user"])

    def test_calculator_reads_only_customer_values_and_current_request(self):
        turns = parse("Клиент: Посчитайте экономию за месяц.\n"
                      "Ассистент: Возьмём ставку 11 ₽/кВт·ч.\n"
                      "Клиент: Посчитайте экономию от замещения 1 000 кВт·ч.")
        note = self.bot.try_calc(turns)
        self.assertIn("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ", note)
        self.assertIn("ставку", note)
        turns.append({"role": "user", "content": "Почему вообще растут счета?"})
        self.assertEqual(self.bot.try_calc(turns), "")

    def test_calculator_uses_replaced_energy_and_explicit_rate(self):
        question = ("Потребляем 3 000 кВт·ч в месяц. Посчитайте экономию при замещении "
                    "1 000 кВт·ч по 8 ₽/кВт·ч за месяц.")
        self.assertIn("8 000 ₽", self.bot.try_calc(parse(question)))

    def test_solar_roof_variants_use_the_indicative_calculator(self):
        for roof in ("скатной кровле", "плоской кровле", "плоской крыше", "крыше"):
            with self.subTest(roof=roof):
                note = self.bot.try_calc(parse(f"Сколько стоит сетевая солнечная станция на 60 кВт на {roof}?"))
                self.assertIn("ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ", note)
                self.assertIn("4 200 000 ₽", note)
                self.assertIn("не итоговая цена", note)
        for config in ("гибридная солнечная станция на 60 кВт на крыше",
                       "сетевая солнечная станция на 60 кВт на фасаде"):
            with self.subTest(config=config):
                self.assertIn("ГРАНИЦА РАСЧЁТА", self.bot.try_calc(parse(f"Сколько стоит {config}?")))

    def test_calculator_resumes_after_customer_provides_rate(self):
        turns = parse("Клиент: Посчитайте экономию при замещении 1 000 кВт·ч.\n"
                      "Ассистент: Какая ставка и период?\n"
                      "Клиент: 8 ₽/кВт·ч за месяц.")
        self.assertIn("8 000 ₽", self.bot.try_calc(turns))
        with patch.dict("os.environ", {"EB_CALC": "1"}):
            self.assertIn("8 000 ₽", self.bot.answer(turns, offline=True).text)

    def test_calculator_resumes_after_multiple_answers(self):
        turns = parse("Клиент: Посчитайте экономию при замещении 1 000 кВт·ч.\n"
                      "Ассистент: Какая ставка?\n"
                      "Клиент: 8 ₽/кВт·ч.\n"
                      "Ассистент: За какой период?\n"
                      "Клиент: За месяц.")
        self.assertIn("8 000 ₽", self.bot.try_calc(turns))

    def test_offline_calculator_returns_missing_input(self):
        question = "Посчитайте экономию при замещении 1 000 кВт·ч за месяц."
        with patch.dict("os.environ", {"EB_CALC": "1"}):
            answer = self.bot.answer(question, offline=True)
        self.assertIn("ставку", answer.text)

    def test_calculator_does_not_reuse_inputs_for_another_object(self):
        turns = parse("Клиент: Посчитайте экономию при замещении 1 000 кВт·ч по 8 ₽/кВт·ч за месяц.\n"
                      "Ассистент: Экономия по сценарию рассчитана.\n"
                      "Клиент: Для другого объекта посчитайте экономию при замещении 500 кВт·ч за месяц.")
        note = self.bot.try_calc(turns)
        self.assertIn("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ", note)
        self.assertIn("ставку", note)

    def test_calculator_reads_power_when_unit_precedes_number(self):
        turns = parse("Можно на оптовый рынок? Присоединение кВт на 720.")
        self.assertIn("720 кВт", self.bot.try_calc(turns))
        self.assertIn("невозможен", self.bot.try_calc(turns))
        spoken = parse("Можно на оптовый рынок? Мощность семьсот двадцать кВт.")
        self.assertIn("720 кВт", self.bot.try_calc(spoken))

    def test_threshold_uses_power_from_previous_turn(self):
        turns = parse("Клиент: У нас присоединённая мощность 900 кВт.\n"
                      "Ассистент: Какая у вас задача?\n"
                      "Клиент: Можем выйти на оптовый рынок?")
        note = self.bot.try_calc(turns)
        self.assertIn("900 кВт", note)
        self.assertIn("посредника", note)

    def test_threshold_requests_power_when_unknown(self):
        note = self.bot.try_calc(parse("Можем выйти на оптовый рынок?"))
        self.assertIn("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ", note)
        self.assertIn("мощность", note)

    def test_threshold_requires_connection_for_multiple_sites(self):
        turns = parse("У нас две площадки, суммарная присоединённая мощность 900 кВт. "
                      "Можем выйти на оптовый рынок?")
        note = self.bot.try_calc(turns)
        self.assertIn("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ", note)
        self.assertIn("электрическая связность", note)
        turns = parse("У нас две площадки по 400 и 500 кВт. Можно объединить для выхода на оптовый рынок?")
        self.assertIn("электрическая связность", self.bot.try_calc(turns))
        turns += [{"role": "assistant", "content": "Есть ли электрическая связность?"},
                  {"role": "user", "content": "Площадки электрически не связаны."}]
        self.assertIn("проверка выполняется отдельно", self.bot.try_calc(turns))
        turns[-1]["content"] = "Площадки электрически связаны."
        self.assertIn("связность", self.bot.try_calc(turns))
        turns[-1]["content"] = "Площадки электрически связаны. К сети подключены на 10 кВ."
        self.assertIn("связность", self.bot.try_calc(turns))
        turns[-1]["content"] = "Площадки электрически связаны по 0,4 кВ."
        self.assertIn("мощность", self.bot.try_calc(turns))

    def test_threshold_combines_only_confirmed_connected_total(self):
        turns = parse("Клиент: Две площадки суммарно имеют 900 кВт. Можем выйти на оптовый рынок?\n"
                      "Ассистент: Есть ли электрическая связность хотя бы по 0,4 кВ?\n"
                      "Клиент: Да, площадки электрически связаны по 0,4 кВ.")
        note = self.bot.try_calc(turns)
        self.assertIn("900 кВт", note)
        self.assertIn("посредника", note)

    def test_threshold_checks_plural_sites_and_individual_power(self):
        turns = parse("Можем выйти на оптовый рынок, если объединить площадки общей мощностью 900 кВт?")
        self.assertIn("связность", self.bot.try_calc(turns))
        turns = parse("Две площадки электрически связаны по 0,4 кВ. "
                      "У каждой по 500 кВт. Можем выйти на оптовый рынок?")
        self.assertIn("мощность", self.bot.try_calc(turns))
        self.assertIn("НЕ ХВАТАЕТ", self.bot.try_calc(turns))

    def test_threshold_in_isolated_region_needs_no_power(self):
        note = self.bot.try_calc(parse("Можем выйти на оптовый рынок на Камчатке?"))
        self.assertIn("оптовый рынок не функционирует", note)
        note = self.bot.try_calc(parse("Мы не на Камчатке, мощность 900 кВт. Можем выйти на оптовый рынок?"))
        self.assertIn("регион не указан", note)

    def test_calculator_is_not_blocked_by_low_retrieval_score(self):
        hits, chunks = self.bot.retrieve()
        self.bot.retrieve.return_value = [Hit(hits[0].chunk, 0.001, "rerank")], chunks
        self.bot.corrective_retry = Mock()
        self.bot.api.chat.return_value = "Расчётная экономия — 8 000 ₽."
        question = "Посчитайте экономию при замещении 1 000 кВт·ч по 8 ₽/кВт·ч за месяц."
        with patch.dict("os.environ", {"EB_CALC": "1", "EB_TWO_STAGE": "0"}):
            answer = self.bot.answer(question)
        self.bot.corrective_retry.assert_not_called()
        self.assertIn("8 000 ₽", answer.text)

    def test_leave_one_out_for_style_examples_and_dialog_turn(self):
        examples = static_example_pairs()
        for question, answer in examples:
            with self.subTest(question=question[:60]):
                turns = parse(question)
                self.assertNotIn((question, answer), filter_examples(examples, turns))
                self.assertNotIn(answer, build_write_messages("материалы", turns, "черновик")[0]["content"])
        question = "Пользователь: Какая у вас кровля?\nАссистент: Уточните тип.\nПользователь: Плоская."
        self.assertEqual(filter_examples([(question, "Пример")], parse("Плоская.")), [])


if __name__ == "__main__":
    unittest.main()
