"""Офлайн-тесты: нарезка базы, разбор диалогов, постобработка, полный прогон solution.py на заглушке API.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import csv
import os
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.guard import normalize_user_quantities, strip_sentences, unknown_numbers  # noqa: E402
from energybot.kb import KnowledgeBase, normalize_tables  # noqa: E402
from energybot.llm import strip_thinking  # noqa: E402
from energybot.pipeline import Consultant, tidy  # noqa: E402
from mock_api import MockApi  # noqa: E402

sys.path.insert(0, str(ROOT / "eval"))
from validate_dataset import load_cases, validate, violates  # noqa: E402
from run_eval import judge_vs_baseline, platform_metrics  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
from build_submission import build as build_zip  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


class KnowledgeBaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb = KnowledgeBase.load(KB_DIR)

    def test_multiline_table_cells_are_merged(self):
        chunk = next(c for c in self.kb.chunks
                     if c.doc.endswith("01-numbers-and-indicators.md") and c.path == "Выход на оптовый рынок")
        self.assertIn("Значение: 750 кВт присоединённой мощности", chunk.text)
        self.assertNotIn("----", chunk.text)

    def test_simple_table(self):
        raw = "  Что          Точность\n  ------------ --------\n  Вода         более 90%\n\nТекст"
        self.assertIn("- Что: Вода; Точность: более 90%", normalize_tables(raw))

    def test_zip_and_dir_give_same_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / "kb.zip"
            with zipfile.ZipFile(zpath, "w") as z:
                for p in KB_DIR.rglob("*.md"):
                    z.write(p, p.relative_to(KB_DIR).as_posix())
            self.assertEqual(KnowledgeBase.load(zpath).fingerprint, self.kb.fingerprint)

    def test_guards_present_for_products(self):
        for doc in ("20-products/23-solar.md", "20-products/22-askue.md", "20-products/24-losses.md"):
            paths = [g.path for g in self.kb.guards(doc)]
            self.assertIn("Чего утверждать нельзя", paths, doc)


class DialogTest(unittest.TestCase):
    def test_single_question(self):
        self.assertEqual(parse("Сколько стоит?"), [{"role": "user", "content": "Сколько стоит?"}])

    def test_dialog_roles_and_multiline(self):
        q = "Пользователь: У нас завод.\nАссистент: Какая мощность?\nПользователь: 800 кВт.\nХватит для опта?"
        turns = parse(q)
        self.assertEqual([t["role"] for t in turns], ["user", "assistant", "user"])
        self.assertEqual(turns[-1]["content"], "800 кВт. Хватит для опта?")
        lexical, semantic, last = search_queries(turns)
        self.assertIn("завод", lexical)
        self.assertIn("Какая мощность", semantic)

    def test_dialog_ending_with_assistant(self):
        turns = parse("Пользователь: Привет\nАссистент: Чем помочь?")
        self.assertEqual(turns[-1]["role"], "user")


class PostprocessTest(unittest.TestCase):
    def test_guard_keeps_equivalent_units_and_ranges(self):
        self.assertEqual(unknown_numbers("От 5 до 10 лет и 25 000 рублей.",
                                         "5–10 лет, цена 25 000 ₽."), [])
        self.assertEqual(unknown_numbers("Расход 850 кВт·ч.", "Расход 850 кВт-ч."), [])
        self.assertEqual(unknown_numbers("Обслуживается более 6 000 приборов.",
                                         "- Показатель: Приборы в системе; Значение: более 6 000; Оговорка: Архив."), [])

    def test_guard_distinguishes_energy_and_power_including_small_values(self):
        answer = "Мощность 2 МВт. Расход 850 кВт·ч. Мощность на шине 850 кВт."
        bad = unknown_numbers(answer, "2 прибора. Мощность на шине 850 кВт.")
        self.assertEqual(bad, ["2 мвт", "850 квтч"])
        self.assertEqual(strip_sentences(answer, bad), "Мощность на шине 850 кВт.")

    def test_guard_expands_numeric_scales(self):
        answer = "Стоимость составит 2,5 млн рублей. Итог согласуют отдельно."
        bad = unknown_numbers(answer, "Ориентир — 5 000 рублей за прибор.")
        self.assertIn("2500000", bad)
        self.assertEqual(strip_sentences(answer, bad), "Итог согласуют отдельно.")
        self.assertEqual(unknown_numbers("Потребление 2,5 млн кВт·ч.", "Потребление 2 500 000 кВт·ч."), [])
        self.assertEqual(unknown_numbers("400 тыс. кВт·ч.", "400 тысяч киловатт-часов."), [])
        self.assertEqual(unknown_numbers("3–5 млн рублей.", "От 3 000 000 до 5 000 000 ₽."), [])

    def test_spoken_quantities_from_customer_allow_matching_digits(self):
        facts = normalize_user_quantities("Около сорока приборов и семьдесят пять объектов. Два года архива.")
        self.assertEqual(unknown_numbers("У вас около 40 приборов, 75 объектов и 2 года архива.", facts), [])
        self.assertEqual(unknown_numbers("Около 40 кВт.", facts), ["40 квт"])
        self.assertIn("двадцать тридцать приборов", normalize_user_quantities("двадцать тридцать приборов"))
        facts = normalize_user_quantities("Нужна станция кВт на 320.")
        self.assertEqual(unknown_numbers("Мощность станции 320 кВт.", facts), [])
        self.assertIn("кВт на 320 приборов", normalize_user_quantities("кВт на 320 приборов"))

    def test_strip_thinking(self):
        self.assertEqual(strip_thinking("<think>a\nb</think>\nОтвет"), "Ответ")
        self.assertEqual(strip_thinking("<think>не закрыто"), "")

    def test_tidy_removes_markdown(self):
        self.assertEqual(tidy("Консультант: **Да**, можно:\n- раз\n- два\nВопрос?"), "Да, можно: раз два Вопрос?")


class DatasetTest(unittest.TestCase):
    def test_dataset_is_valid_and_split(self):
        path = ROOT / "eval" / "dataset" / "cases.jsonl"
        cases = load_cases([path])
        errors, _ = validate(cases, KnowledgeBase.load(KB_DIR))
        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(cases), 450)
        holdout = sum(c["split"] == "holdout" for c in cases) / len(cases)
        self.assertTrue(0.25 <= holdout <= 0.35, holdout)

    def test_must_not_respects_negation(self):
        self.assertFalse(violates("гарантируем", "Мы не гарантируем экономию."))
        self.assertTrue(violates("гарантируем", "Гарантируем 15% экономии."))
        self.assertFalse(violates("50\\s?%", "Скидку 50% пообещать не могу."))
        self.assertTrue(violates("^да\\b", "Да, конечно."))
        self.assertTrue(violates("не обрабатыва", "Нельзя утверждать, что не обрабатывает."))


class JudgeMetricsTest(unittest.TestCase):
    def test_platform_formula(self):
        m = platform_metrics([1.0, 0.75, 0.5, 0.25, None])
        self.assertEqual((m["n"], m["wins"], m["losses"], m["ties"]), (4, 2, 1, 1))
        self.assertAlmostEqual(m["match_rate"], 0.625)
        self.assertAlmostEqual(m["win_rate"], 2 / 3)
        self.assertAlmostEqual(m["score"], 0.7 * 0.625 + 0.3 * 2 / 3)
        self.assertEqual(platform_metrics([0.5, 0.5])["win_rate"], 0.5)

    def test_position_bias_cancels_out(self):
        class AlwaysB:
            def chat(self, messages):
                return '{"verdict": "B_better", "reason": "B"}'

        score, _ = judge_vs_baseline(AlwaysB(), "вопрос", "эталон", "команда", "бейзлайн")
        self.assertEqual(score, 0.5)

    def test_team_clearly_better(self):
        class PrefersTeam:
            def chat(self, messages):
                text = messages[-1]["content"]
                b_is_team = text.rstrip().endswith("команда")
                return '{"verdict": "%s"}' % ("B_much_better" if b_is_team else "A_much_better")

        score, _ = judge_vs_baseline(PrefersTeam(), "вопрос", "эталон", "команда", "бейзлайн")
        self.assertEqual(score, 1.0)


class BlindJudgeTest(unittest.TestCase):
    def test_export_hides_side_and_score_matches_platform(self):
        import json as _json
        import blind_judge
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp)
            for side, text in (("bot", "ответ бота"), ("baseline", "ответ бейзлайна")):
                (report / side).mkdir()
                with open(report / side / "submission.csv", "w", encoding="utf-8", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["id", "answer"])
                    w.writerows([("demo-1", f"{text} 1"), ("demo-2", f"{text} 2")])
            blind_judge.export(report, parts=2, seed=1)
            packets = "".join(p.read_text(encoding="utf-8") for p in (report / "blind").glob("packet-*.md"))
            self.assertNotIn("demo-1", packets)  # в пакетах нет идентификаторов кейсов
            key = _json.loads((report / "blind" / "key.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(k["round"] for k in key.values()), [1, 1, 2, 2])
            verdicts = [_json.dumps({"pid": p, "verdict": "B_better" if k["team"] == "B" else "A_better"})
                        for p, k in key.items()]
            (report / "blind" / "verdicts-01.jsonl").write_text("\n".join(verdicts), encoding="utf-8")
            blind_judge.score(report)
            text = (report / "blind" / "report.md").read_text(encoding="utf-8")
        self.assertIn("Score = 0.825", text)  # «немного лучше» везде: 0,7·0,75 + 0,3·1


class DeadlineTest(unittest.TestCase):
    def test_no_requests_after_deadline(self):
        import time as _time
        from energybot.llm import Api, DeadlineExceeded
        api = Api()
        api.base_url, api.llm_key = "http://127.0.0.1:9", "k"
        api.deadline = _time.perf_counter() - 1
        with self.assertRaises(DeadlineExceeded):
            api.chat([{"role": "user", "content": "x"}])


def _consultant(mock):
    from energybot.llm import Api
    from energybot.pipeline import Consultant
    old = {k: os.environ.get(k) for k in ("LLM_BASE_URL", "LLM_API_KEY")}
    os.environ.update(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key")
    try:
        return Consultant(KB_DIR, api=Api())
    finally:
        for k, v in old.items():
            os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)


class GuardTest(unittest.TestCase):
    QUESTION = "Сколько будет стоить платформа учёта на 150 приборов?"
    BAD = "Ориентир — 25 000 руб в год за прибор. Итого проект обойдётся в 3 750 000 рублей. Сколько у вас объектов?"
    GOOD = "Ориентир — 25 000 руб в год за прибор, на объёмных внедрениях стоимость считается отдельно. Сколько у вас объектов?"

    def test_assistant_history_is_not_a_numeric_source(self):
        turns = [
            {"role": "assistant", "content": "Проект стоит 987 654 рублей."},
            {"role": "user", "content": "Это окончательная цена?"},
        ]
        text, guard = Consultant.check(
            None, "Окончательная цена — 987 654 рублей.", [], "", turns, fast=True,
        )
        self.assertNotIn("987 654", text)
        self.assertEqual(guard["stripped"], ["987654"])

    def test_invented_number_triggers_repair(self):
        def responder(messages):
            # Хороший ответ отдаём только на ремонт guard'а; черновики и проверка — плохие.
            return self.GOOD if "Не называй их" in messages[-1]["content"] else self.BAD

        with MockApi(reject_template_kwargs=False, responder=responder) as mock:
            result = _consultant(mock).answer(self.QUESTION)
        self.assertEqual(result.text, self.GOOD)
        self.assertEqual(result.guard["unknown_numbers"], ["3750000"])
        self.assertTrue(result.guard["repaired"])

    def test_stubborn_model_gets_sentence_stripped(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: self.BAD) as mock:
            result = _consultant(mock).answer(self.QUESTION)
        self.assertNotIn("3 750 000", result.text)
        self.assertIn("25 000", result.text)
        self.assertEqual(result.guard["stripped"], ["3750000"])

    def test_clean_answer_is_untouched(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: self.GOOD) as mock:
            result = _consultant(mock).answer(self.QUESTION)
            calls = mock.calls["chat"]
        self.assertEqual((result.text, result.guard), (self.GOOD, {}))
        self.assertEqual(calls, 3)  # ответ, ансамбль и самопроверка


class EmbeddingBatchTest(unittest.TestCase):
    def test_batch_shrinks_on_provider_limit(self):
        with MockApi(reject_template_kwargs=False, max_embed_batch=5) as mock:
            bot = _consultant(mock)
        self.assertTrue(bot.dense)
        self.assertLessEqual(bot.api.embed_batch, 5)


class SolutionEndToEndTest(unittest.TestCase):
    def _run(self, mock: MockApi, questions: list, script: Path = ROOT / "solution.py",
             extra_env: dict | None = None) -> tuple:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            with open(data / "questions.csv", "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f, quoting=csv.QUOTE_ALL)
                w.writerow(["id", "question"])
                w.writerows(questions)
            with zipfile.ZipFile(data / "knowledge-base.zip", "w") as z:
                for p in KB_DIR.rglob("*.md"):
                    z.write(p, p.relative_to(KB_DIR).as_posix())
            env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "OPENAI_", "JUDGE_"))}
            env.update(DATA_DIR=str(data), LLM_BASE_URL=mock.url, LLM_API_KEY="test-key", MAX_WORKERS="3")
            env.update(extra_env or {})
            env.pop("PYTHONPATH", None)
            proc = subprocess.run([sys.executable, str(script)], cwd=tmp, env=env,
                                  capture_output=True, text=True, timeout=300)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(Path(tmp) / "submission.csv", encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            return rows, proc.stderr

    def test_full_run_with_quirky_server(self):
        questions = [("7", "Можно ли поставить панели на шиферную крышу?"),
                     ("3", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт. Подойдёт?"),
                     ("10", "Сколько стоит платформа учёта?")]
        with MockApi(reject_template_kwargs=True) as mock:
            rows, log = self._run(mock, questions, extra_env={"EB_THINKING_PARAM": "chat_template_kwargs"})
        self.assertEqual([r["id"] for r in rows], ["7", "3", "10"])
        for r in rows:
            self.assertEqual(r["answer"], "Да, это возможно: первый факт второй факт Какой у вас регион?")
        self.assertGreaterEqual(mock.calls["rejected"], 1)  # отказ от chat_template_kwargs обработан
        self.assertGreaterEqual(mock.calls["embeddings"], 1)
        self.assertGreaterEqual(mock.calls["rerank"], 1)
        roles = [m["role"] for m in mock.last_messages]
        self.assertEqual(roles[0], "system")
        self.assertIn("МАТЕРИАЛЫ", mock.last_messages[0]["content"])

    def test_dialog_history_is_passed_as_turns(self):
        with MockApi(reject_template_kwargs=False) as mock:
            self._run(mock, [("1", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт.")])
        # Реплики диалога идут после системного промпта и few-shot примеров,
        # в исходном порядке (могут следовать служебные сообщения второго прохода).
        self.assertEqual(mock.last_messages[0]["role"], "system")
        contents = [m["content"] for m in mock.last_messages]
        for j, c in enumerate(contents):
            if c == "Мы СНТ.":
                self.assertEqual(contents[j + 1], "Какая задача?")
                self.assertEqual(contents[j + 2], "Учёт.")
                self.assertEqual([m["role"] for m in mock.last_messages[j:j + 3]],
                                 ["user", "assistant", "user"])
                break
        else:
            self.fail("реплики диалога не дошли до модели")

    def test_flat_zip_runs_like_on_platform(self):
        """Сабмит из распакованного ZIP: только корневые .py и requirements.txt, без energybot/."""
        with tempfile.TemporaryDirectory() as unpacked:
            archive = Path(unpacked) / "submission.zip"
            names = build_zip(archive)
            self.assertTrue(all("/" not in n for n in names))
            self.assertNotIn("index", " ".join(names))
            with zipfile.ZipFile(archive) as z:
                z.extractall(Path(unpacked) / "app")
            questions = [("1", "Сколько стоит платформа учёта?"),
                         ("2", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт. Подойдёт?")]
            with MockApi(reject_template_kwargs=False) as mock:
                rows, log = self._run(mock, questions, script=Path(unpacked) / "app" / "solution.py")
        self.assertEqual([r["id"] for r in rows], ["1", "2"])
        self.assertTrue(all(r["answer"].startswith("Да, это возможно") for r in rows), log)

    def test_budget_switches_to_fast_and_meets_deadline(self):
        """Медленный сервис и короткий дедлайн: все ответы непустые, есть быстрый режим, укладываемся в лимит."""
        questions = [(str(i), f"Вопрос номер {i} про солнечные станции и платформу учёта?") for i in range(70)]
        started = time.perf_counter()
        with MockApi(reject_template_kwargs=False, chat_delay=1.0, rerank_delay=0.5) as mock:
            rows, log = self._run(mock, questions, extra_env={"EB_DEADLINE_SEC": "30", "MAX_WORKERS": "2"})
        elapsed = time.perf_counter() - started
        self.assertEqual(len(rows), 70)
        self.assertTrue(all(r["answer"].strip() for r in rows))
        self.assertIn("быстрый режим", log)
        self.assertLess(elapsed, 45, log[-500:])

    def test_llm_outage_still_gives_valid_submission(self):
        with MockApi(fail_chat=True) as mock:
            rows, _ = self._run(mock, [("1", "Вопрос один?"), ("2", "Вопрос два?")])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("специалист" in r["answer"] for r in rows))


if __name__ == "__main__":
    unittest.main()
