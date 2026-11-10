"""Офлайн-тесты таксономии неоднозначностей и обязательных расчётов."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from energybot.ambiguity import AmbiguityClassifier, fallback_decision, normalize_decision  # noqa: E402
from energybot.calc import calculate, extract_parameters, render_calculation  # noqa: E402
from energybot.dialog import parse  # noqa: E402
from energybot.llm import Api  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402
from mock_api import MockApi  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


def request(operation, **params):
    return {"operation": operation, "parameters": params, "object": "current", "period": params.pop("period", "")}


class AmbiguityTest(unittest.TestCase):
    def test_process_question_is_not_calculation(self):
        decision = fallback_decision(parse("Что нужно для расчёта окупаемости?"))
        self.assertEqual(decision["action"], "answer")

    def test_reference_price_and_payback_questions_stay_in_rag(self):
        self.assertEqual(fallback_decision(parse("Сколько стоит платформа учёта?"))["action"], "answer")
        self.assertEqual(fallback_decision(parse("Какая окупаемость у солнечной станции?"))["action"], "answer")

    def test_explicit_calculation_survives_classifier_failure(self):
        decision = fallback_decision(parse("Посчитай снижение на 12 000 кВт·ч по 8,50 ₽/кВт·ч."))
        self.assertEqual(decision["action"], "calculate")
        self.assertEqual(decision["calculation"]["operation"], "energy_savings")
        self.assertEqual(decision["calculation"]["parameters"]["replaced_kwh"], "12000")

    def test_repeated_question_is_removed(self):
        turns = parse("Пользователь: Хочу станцию.\nАссистент: Какая у вас цель?\nПользователь: Вечерняя нагрузка.")
        data = {"action": "answer_and_clarify", "ambiguities": [{"type": "goal", "field": "goal", "severity": "blocking"}],
                "questions": [{"field": "goal", "question": "Какая у вас цель?", "options": [], "reason": ""}]}
        self.assertEqual(normalize_decision(data, turns)["action"], "answer")

    def test_valid_question_is_schema_driven(self):
        turns = parse("Хочу солнечную станцию.")
        data = {"action": "answer_and_clarify", "ambiguities": [{"type": "goal", "field": "solar_goal", "severity": "blocking"}],
                "questions": [{"field": "solar_goal", "question": "Что важнее: платёж или надёжность?",
                               "options": ["Платёж", "Надёжность"], "reason": "Выбор конфигурации"}]}
        result = normalize_decision(data, turns)
        self.assertEqual(result["action"], "answer_and_clarify")
        self.assertEqual(result["questions"][0]["field"], "solar_goal")

    def test_direct_answer_cannot_be_replaced_by_clarification(self):
        turns = parse("Вы сначала проверите наш учёт?")
        data = {"action": "clarify", "direct_answer_available": True, "partial_answer_allowed": False,
                "ambiguities": [{"type": "missing_input", "field": "power", "severity": "optional"}],
                "questions": [{"field": "power", "question": "Какая у вас присоединённая мощность?",
                               "options": [], "reason": "Проверка порога"}]}
        result = normalize_decision(data, turns)
        self.assertEqual(result["action"], "answer_and_clarify")
        self.assertTrue(result["partial_answer_allowed"])

    def test_clarify_only_when_direct_answer_is_impossible(self):
        turns = parse("Сколько это стоит?")
        data = {"action": "clarify", "direct_answer_available": False, "partial_answer_allowed": False,
                "ambiguities": [{"type": "reference", "field": "product", "severity": "blocking"}],
                "questions": [{"field": "product", "question": "О каком продукте речь?", "options": [], "reason": ""}]}
        result = normalize_decision(data, turns)
        self.assertEqual(result["action"], "clarify")
        self.assertFalse(result["partial_answer_allowed"])
        self.assertFalse(result["direct_answer_available"])

    def test_answer_and_clarify_requires_direct_answer(self):
        turns = parse("Сколько это стоит?")
        data = {"action": "answer_and_clarify", "direct_answer_available": False,
                "questions": [{"field": "product", "question": "О каком продукте речь?", "options": [], "reason": ""}]}
        result = normalize_decision(data, turns)
        self.assertEqual(result["action"], "clarify")
        self.assertFalse(result["partial_answer_allowed"])


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
        old = {k: os.environ.get(k) for k in ("LLM_BASE_URL", "LLM_API_KEY")}
        os.environ.update(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key")
        try:
            return Consultant(KB_DIR, api=Api())
        finally:
            for key, value in old.items():
                os.environ.pop(key) if value is None else os.environ.__setitem__(key, value)

    def test_pipeline_calls_calculator_instead_of_generating_answer(self):
        decision = {"action": "calculate", "ambiguities": [], "known_fields": [], "questions": [],
                    "partial_answer_allowed": False,
                    "calculation": {"operation": "energy_savings", "object": "current", "period": "month",
                                    "parameters": {"replaced_kwh": "12000", "rate_rub_per_kwh": "8.50"},
                                    "provenance": {}}}
        with MockApi(reject_template_kwargs=False, responder=lambda messages: json.dumps(decision, ensure_ascii=False)) as mock:
            result = self._consultant(mock).answer("Посчитай снижение на 12 000 кВт·ч по 8,50 ₽/кВт·ч.")
            calls = mock.calls["chat"]
        self.assertEqual(calls, 1)  # только быстрый классификатор; генерации ответа не было
        self.assertEqual(result.guard["calculation"]["status"], "ok")
        self.assertIn("102 000 ₽", result.text)

    def test_pipeline_returns_missing_parameter_question(self):
        decision = {"action": "calculate", "ambiguities": [], "known_fields": [], "questions": [],
                    "calculation": {"operation": "energy_savings", "object": "current", "period": "month",
                                    "parameters": {"replaced_kwh": "12000"}, "provenance": {}}}
        with MockApi(reject_template_kwargs=False, responder=lambda messages: json.dumps(decision, ensure_ascii=False)) as mock:
            result = self._consultant(mock).answer("Посчитай снижение на 12 000 кВт·ч.")
        self.assertEqual(result.guard["calculation"]["status"], "needs_input")
        self.assertIn("ставку", result.text)
        self.assertEqual(result.action, "answer_clarify")


if __name__ == "__main__":
    unittest.main()
