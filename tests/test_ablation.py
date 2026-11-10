"""Офлайн-тесты сводки ablation-прогонов."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from ablation import collect_report, config_env, paired  # noqa: E402


class AblationTest(unittest.TestCase):
    def _report(self, rows: list) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name)
        (path / "details.jsonl").write_text(
            "\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        return path

    def test_absolute_summary_and_breakdown(self):
        report = self._report([
            {"kind": "check", "ok": True},
            {"kind": "check", "ok": False},
            {"kind": "judge", "mode": "absolute", "id": "a", "type": "dialog", "score": 8},
            {"kind": "judge", "mode": "absolute", "id": "b", "type": "single", "score": 6},
            {"kind": "judge", "mode": "absolute", "id": "c", "type": "single", "score": None},
        ])
        result = collect_report(report)
        self.assertEqual(result["score"], 7)
        self.assertEqual(result["dialog"], 8)
        self.assertEqual(result["single"], 6)
        self.assertEqual((result["judged"], result["judge_failed"]), (2, 1))
        self.assertEqual((result["checks_passed"], result["checks_total"]), (1, 2))

    def test_platform_summary_uses_official_formula(self):
        report = self._report([
            {"kind": "judge", "mode": "platform", "id": "a", "score": 1},
            {"kind": "judge", "mode": "platform", "id": "b", "score": 0.5},
            {"kind": "judge", "mode": "platform", "id": "c", "score": 0},
            {"kind": "judge", "mode": "platform", "id": "d", "score": None},
        ])
        result = collect_report(report)
        self.assertAlmostEqual(result["score"], 5)
        self.assertAlmostEqual(result["match_rate"], 5)
        self.assertAlmostEqual(result["win_rate"], 5)

    def test_paired_comparison_uses_common_valid_cases(self):
        comparison = paired({"a": 0.5, "b": 0.75, "c": None, "d": 1},
                            {"a": 0.75, "b": 0.5, "c": 1, "d": None, "e": 1})
        self.assertEqual(comparison, {"better": 1, "worse": 1, "same": 0, "n": 2})

    def test_config_env_does_not_leak_flags(self):
        with patch.dict(os.environ, {"EB_VERIFY": "1", "EB_LLM_SELECT": "1"}, clear=False):
            env = config_env("one_pass")
            self.assertEqual(env["EB_VERIFY"], "0")
            self.assertEqual(env["EB_LLM_SELECT"], "0")
            self.assertEqual(os.environ["EB_VERIFY"], "1")


if __name__ == "__main__":
    unittest.main()
