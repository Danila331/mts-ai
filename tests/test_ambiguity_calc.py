"""Офлайн-тесты таксономии неоднозначностей и обязательных расчётов."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mock_api import MockApi  # noqa: E402

from energybot.ambiguity import fallback_decision, normalize_decision  # noqa: E402
from energybot.calc import calculate  # noqa: E402
from energybot.dialog import parse  # noqa: E402
from energybot.llm import Api  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


def request(operation, **params):
    return {"operation": operation, "parameters": params, "object": "current", "period": params.pop("period", "")}


class AmbiguityTest(unittest.TestCase):
    def test_fallback_is_direct_answer_without_unnecessary_question(self):
        for question in ("Что нужно для расчёта окупаемости?", "Сколько стоит платформа учёта?",
                         "Посчитай снижение на 12 000 кВт·ч по 8,50 ₽/кВт·ч."):
            self.assertEqual(fallback_decision(parse(question)),
                             {"type": "none", "known": {}, "missing": [], "question": ""})

    def test_repeated_question_is_removed(self):
        turns = parse("Пользователь: Хочу станцию.\nАссистент: Какая у вас цель?\nПользователь: Вечерняя нагрузка.")
        data = {"type": "goal_branch", "known": {"goal": "резерв"}, "missing": [],
                "question": "Какая у вас цель?"}
        result = normalize_decision(data, turns)
        self.assertEqual(result["type"], "goal_branch")
        self.assertEqual(result["question"], "")

    def test_valid_question_and_known_fields_are_preserved(self):
        turns = parse("Хочу солнечную станцию.")
        data = {"type": "goal_branch", "known": {"product": "solar"}, "missing": ["goal"],
                "question": "Что важнее: платёж или надёжность?"}
        result = normalize_decision(data, turns)
        self.assertEqual(result["question"], "Что важнее: платёж или надёжность?")
        self.assertEqual(result["known"], {"product": "solar"})
        self.assertEqual(result["missing"], ["goal"])

    def test_invalid_decision_fails_open_to_direct_answer(self):
        result = normalize_decision({"type": "unknown", "question": "Лишний вопрос?"}, parse("Вопрос"))
        self.assertEqual(result["type"], "none")
        self.assertEqual(result["question"], "")


class CalculatorTest(unittest.TestCase):
    def test_threshold_converts_mw(self):
        result = calculate(request("threshold_check", power_value="0.8", power_unit="MW"))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["value"] == "True")
        self.assertIn("800 кВт", result["formatted"])
        self.assertTrue(result["conditional"])

    def test_threshold_boundaries_and_isolated_region(self):
        self.assertIn("невозможен", calculate(request("threshold_check", power_kw="749"))["formatted"])
        self.assertIn("посредника", calculate(request("threshold_check", power_kw="750"))["formatted"])
        self.assertIn("прямое", calculate(request("threshold_check", power_kw="20000"))["formatted"])
        self.assertFalse(calculate(request("threshold_check", power_kw="800", region="Камчатка"))["value"] == "True")

    def test_sites_require_electrical_connection(self):
        missing = calculate(request("threshold_check", power_kw="1500", sites=2))
        self.assertEqual(missing["status"], "needs_input")
        separate = calculate(request("threshold_check", power_kw="1500", sites=2, electrically_connected=False))
        self.assertIn("нельзя суммировать", separate["formatted"])

    def test_wrong_threshold_unit_is_rejected(self):
        result = calculate(request("threshold_check", power_value="800", power_unit="kWh"))
        self.assertEqual(result["status"], "invalid")

    def test_indicative_solar_cost(self):
        result = calculate(request("solar_indicative_cost", power_value="60", power_unit="kW",
                                   station_type="grid", placement="rooftop"))
        self.assertEqual(result["value"], "4200000")
        self.assertIn("4 200 000 ₽", result["formatted"])

    def test_hybrid_cost_is_not_estimated_by_grid_formula(self):
        result = calculate(request("solar_indicative_cost", power_value="60", power_unit="kW",
                                   station_type="hybrid", placement="rooftop"))
        self.assertEqual(result["status"], "unsupported")

    def test_platform_cost_only_for_explicit_scenario(self):
        actual = calculate(request("platform_indicative_cost", device_count="150"))
        self.assertEqual(actual["status"], "unsupported")
        scenario = calculate(request("platform_indicative_cost", device_count="12", explicit_scenario=True))
        self.assertEqual(scenario["value"], "300000")

    def test_energy_savings(self):
        result = calculate(request("energy_savings", replaced_kwh="12000", rate_rub_per_kwh="8.50", period="month"))
        self.assertEqual(result["value"], "102000.00")
        self.assertIn("102 000 ₽", result["formatted"])

    def test_missing_rate_returns_question_not_guess(self):
        result = calculate(request("energy_savings", replaced_kwh="12000", period="month"))
        self.assertEqual(result["status"], "needs_input")
        self.assertIn("₽/кВт·ч", result["questions"][0])

    def test_bill_comparison_and_zero_base(self):
        result = calculate(request("bill_compare", before_total="100", after_total="120"))
        self.assertEqual(result["value"], "20")
        self.assertEqual(str(result["percent"]), "20.0")
        zero = calculate(request("bill_compare", before_total="0", after_total="120"))
        self.assertIsNone(zero["percent"])

    def test_simple_payback_requires_explicit_scenario(self):
        unsupported = calculate(request("simple_payback", investment_rub="100", annual_net_effect_rub="20"))
        self.assertEqual(unsupported["status"], "unsupported")
        result = calculate(request("simple_payback", investment_rub="100", annual_net_effect_rub="20",
                                   explicit_scenario=True))
        self.assertEqual(result["value"], "5")

    def test_maintenance_uses_panel_cost_not_project_cost(self):
        result = calculate(request("solar_maintenance", panel_cost_rub="1000000"))
        self.assertEqual(result["value"], "5000.000")


class PipelineCalculationTest(unittest.TestCase):
    def _consultant(self, mock):
        keys = ("LLM_BASE_URL", "LLM_API_KEY", "EB_QTYPE", "EB_GOLD_FEWSHOT")
        old = {k: os.environ.get(k) for k in keys}
        os.environ.update(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key", EB_QTYPE="0", EB_GOLD_FEWSHOT="0")
        try:
            return Consultant(KB_DIR, api=Api())
        finally:
            for key, value in old.items():
                os.environ.pop(key) if value is None else os.environ.__setitem__(key, value)

    def test_pipeline_uses_deterministic_calculation_in_context(self):
        bot = None
        with MockApi(reject_template_kwargs=False, responder=lambda messages: "Экономия — 102 000 ₽.") as mock:
            bot = self._consultant(mock)
            note = bot.try_calc(parse("Посчитай снижение на 12 000 кВт·ч по 8,50 ₽/кВт·ч за месяц."))
            result = bot.answer("Посчитай снижение на 12 000 кВт·ч по 8,50 ₽/кВт·ч за месяц.")
        self.assertIn("ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ", note)
        self.assertIn("102 000 ₽", note)
        self.assertIn("ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ", mock.last_messages[0]["content"])
        self.assertEqual(result.text, "Экономия — 102 000 ₽.")
        self.assertEqual(result.error, "")

    def test_pipeline_returns_missing_parameter_question(self):
        with MockApi(reject_template_kwargs=False, responder=lambda messages: "Укажите ставку в ₽/кВт·ч.") as mock:
            bot = self._consultant(mock)
            note = bot.try_calc(parse("Посчитай снижение на 12 000 кВт·ч."))
            result = bot.answer("Посчитай снижение на 12 000 кВт·ч.")
        self.assertIn("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ", note)
        self.assertIn("ставку", result.text)
        self.assertEqual(result.error, "")


if __name__ == "__main__":
    unittest.main()
