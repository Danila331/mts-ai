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

from mock_api import MockApi  # noqa: E402

from energybot.dialog import parse, search_queries  # noqa: E402
from energybot.kb import KnowledgeBase, normalize_tables  # noqa: E402
from energybot.llm import strip_thinking  # noqa: E402
from energybot.pipeline import tidy  # noqa: E402

sys.path.insert(0, str(ROOT / "eval"))
from run_eval import judge_vs_baseline, platform_metrics  # noqa: E402
from validate_dataset import load_cases, validate, violates  # noqa: E402

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
        """Отвечаем на последнюю реплику пользователя (регламент, раздел 3): реплику за клиента не выдумываем."""
        turns = parse("Пользователь: Сколько служат панели?\nАссистент: Уточняю данные по вашему вопросу.")
        self.assertEqual(turns, [{"role": "user", "content": "Сколько служат панели?"}])
        self.assertEqual(search_queries(turns)[2], "Сколько служат панели?")
        self.assertEqual(parse("Ассистент: Чем помочь?"), [{"role": "user", "content": "Ассистент: Чем помочь?"}])


class PostprocessTest(unittest.TestCase):
    def test_strip_thinking(self):
        self.assertEqual(strip_thinking("<think>a\nb</think>\nОтвет"), "Ответ")
        self.assertEqual(strip_thinking("<think>не закрыто"), "")

    def test_strip_thinking_with_closing_tag_only(self):
        """vLLM без разбора размышлений отдаёт рассуждение и ответ одним текстом с одной меткой </think>."""
        raw = "Клиент спрашивает про скаты. В базе сказано, что используются оба.\n</think>\n\nДа, можно."
        self.assertEqual(strip_thinking(raw), "Да, можно.")
        self.assertEqual(strip_thinking("<think>a</think>первый</think>Ответ"), "Ответ")
        self.assertEqual(strip_thinking("рассуждение без ответа</think>"), "")

    def test_kb_check_verdicts(self):
        """Указание генератору даёт только вердикт «НЕТ»; «ЕСТЬ» и «ВНЕ ТЕМЫ» оставляют запрос как в v3."""
        from energybot.prompts import parse_check
        self.assertEqual(parse_check("БЛИЖАЙШЕЕ В БАЗЕ: «…» — раздел\nВЕРДИКТ: НЕТ: срок хранения истории."),
                         "срок хранения истории")
        self.assertEqual(parse_check("БЛИЖАЙШЕЕ В БАЗЕ: «…»\nВЕРДИКТ: ЕСТЬ"), "")
        self.assertEqual(parse_check("БЛИЖАЙШЕЕ В БАЗЕ: «…»\nВЕРДИКТ: ВНЕ ТЕМЫ"), "")
        self.assertEqual(parse_check("что-то неразборчивое"), "")

    def test_inline_evidence_is_split_from_answer(self):
        """Опора и ответ приходят одним текстом: клиенту уходит только то, что после метки ОТВЕТ."""
        from energybot.prompts import split_inline_evidence
        raw = "ЦИТАТЫ:\n- «Порог — 750 кВт» — Оптовый рынок\nНЕТ В БАЗЕ: —\nПРИМЕНИМОСТЬ: —\nОТВЕТ:\nДа, от 750 кВт."
        answer, evidence = split_inline_evidence(raw)
        self.assertEqual(answer, "Да, от 750 кВт.")
        self.assertIn("750 кВт", evidence)
        self.assertEqual(split_inline_evidence("ЦИТАТЫ:\n- «…»\nНЕТ В БАЗЕ: —"), ("", ""))  # формат не соблюдён
        self.assertEqual(split_inline_evidence("Просто ответ."), ("Просто ответ.", ""))

    def test_copilot_rules_stay_out_of_chat_and_eval(self):
        """Копилот менеджера (T11) — отдельный блок: промпты чата и автопроверки не меняются ни на символ."""
        from energybot.guard import repair_instruction
        from energybot.prompts import COPILOT_MODE, COPILOT_TAIL, build_messages, build_write_messages
        turns = [{"role": "user", "content": "Сравни платформу учёта и поиск потерь"}]
        for style in ("tight", "full", "recipe", "jury", "jury2"):
            for mode in ("eval", "chat"):
                for msgs in (build_messages("СПР", "МАТ", turns, mode, style=style, near=2),
                             build_write_messages("МАТ", turns, "черновик", mode)):
                    text = "\n".join(m["content"] for m in msgs)
                    self.assertNotIn("КОПИЛОТ", text, f"{mode}/{style}")
                    self.assertNotIn(COPILOT_TAIL, text, f"{mode}/{style}")
            copilot = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", turns, "copilot", style=style, near=2))
            self.assertIn(COPILOT_MODE.strip(), copilot)
            self.assertIn(COPILOT_TAIL, copilot)
            self.assertNotIn("ПРИМЕРЫ ЭТАЛОННЫХ ОТВЕТОВ", copilot, "эталоны клиенту задали бы копилоту чужую форму")
            self.assertNotIn("РАБОТА С ЗАЯВКОЙ", copilot)
        # Проверка длины: прежний текст у чата и автопроверки, свой предел у копилота.
        self.assertIn("40–60 слов", repair_instruction([], True))
        self.assertIn("150 слов", repair_instruction([], True, "150 слов"))

    def test_chat_mode_only_in_chat(self):
        """Заявка в чате (T2): правила про контакты и форму — только в режиме chat; автопроверка их не видит."""
        from energybot.prompts import CHAT_MODE, build_messages, build_write_messages
        turns = [{"role": "user", "content": "Нужен учёт на складе"}]
        for style in ("tight", "full", "recipe", "jury", "jury2"):
            for msgs in (build_messages("СПР", "МАТ", turns, "eval", style=style), build_write_messages("МАТ", turns, "ч", "eval")):
                self.assertNotIn(CHAT_MODE.strip(), "\n".join(m["content"] for m in msgs), style)
            chat = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", turns, "chat", style=style))
            self.assertIn(CHAT_MODE.strip(), chat)
        self.assertIn("ниже откроется форма", CHAT_MODE)
        self.assertIn("Никогда не пиши, что заявка уже отправлена", CHAT_MODE)

    def test_tidy_removes_markdown(self):
        self.assertEqual(tidy("Консультант: **Да**, можно:\n- раз\n- два\nВопрос?"), "Да, можно: раз два Вопрос?")

    def test_no_model_answer_is_refusal(self):
        """Без модели нельзя проверить, есть ли в разделе ответ, поэтому — корректный отказ (регламент, раздел 7),
        а не выдержка: на «срок поставки» выдержка отдала бы срок службы панелей."""
        from energybot.pipeline import FALLBACK, Consultant
        bot = Consultant(KB_DIR, api=None)
        for q in ("Как приготовить борщ?", "Каков точный срок поставки солнечной станции?"):
            self.assertEqual(bot.answer(parse(q), mode="eval", offline=True).text, FALLBACK)


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

    def test_invented_number_triggers_repair(self):
        def responder(messages):
            return self.GOOD if messages[-1]["content"].startswith("[Служебная") else self.BAD

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

    def test_unverifiable_short_answer_is_replaced(self):
        """Если без непроверенных чисел ответа почти не остаётся — выдержка из базы, а не выдумка."""
        with MockApi(reject_template_kwargs=False, responder=lambda m: "Стоимость составит 999 999 рублей.") as mock:
            result = _consultant(mock).answer(self.QUESTION)
        self.assertNotIn("999", result.text)
        self.assertEqual(result.guard["dropped"], ["999999"])
        self.assertTrue(result.text.strip())

    def test_clean_answer_is_untouched(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: self.GOOD) as mock:
            result = _consultant(mock).answer(self.QUESTION)
            calls = mock.calls["chat"]
        self.assertEqual((result.text, result.guard, calls), (self.GOOD, {}, 1))


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
            rows, log = self._run(mock, questions)
        self.assertEqual([r["id"] for r in rows], ["7", "3", "10"])
        for r in rows:
            self.assertEqual(r["answer"], "Да, это возможно: первый факт второй факт Какой у вас регион?")
        self.assertGreaterEqual(mock.calls["rejected"], 1)  # отказ от chat_template_kwargs обработан
        self.assertGreaterEqual(mock.calls["embeddings"], 1)
        self.assertGreaterEqual(mock.calls["rerank"], 1)
        roles = [m["role"] for m in mock.last_messages]
        self.assertEqual(roles, ["system", "user"])
        self.assertIn("СПРАВОЧНИК", mock.last_messages[0]["content"])
        self.assertIn("МАТЕРИАЛЫ ПО ВОПРОСУ", mock.last_messages[1]["content"])

    def test_dialog_history_is_passed_to_model(self):
        """Диалог целиком идёт последним блоком запроса: модель отвечает на последнюю реплику клиента."""
        with MockApi(reject_template_kwargs=False) as mock:
            self._run(mock, [("1", "Пользователь: Мы СНТ.\nАссистент: Какая задача?\nПользователь: Учёт.")])
        user = mock.last_messages[-1]["content"]
        self.assertIn("Клиент: Мы СНТ.\nКонсультант: Какая задача?\nКлиент: Учёт.", user)
        self.assertLess(user.index("МАТЕРИАЛЫ ПО ВОПРОСУ"), user.index("ДИАЛОГ"))

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

    def test_inline_evidence_never_reaches_submission(self):
        raw = "ЦИТАТЫ:\n- «Минимального количества приборов нет.» — Платформа\nНЕТ В БАЗЕ: —\nПРИМЕНИМОСТЬ: ДА\nОТВЕТ:\nДа, подойдёт."
        with MockApi(reject_template_kwargs=False, responder=lambda m: raw) as mock:
            rows, _ = self._run(mock, [("1", "Нам подойдёт платформа учёта?")], extra_env={"EB_EVIDENCE": "2"})
            calls = mock.calls["chat"]
        self.assertEqual(rows[0]["answer"], "Да, подойдёт.")
        self.assertEqual(calls, 1)

    def test_kb_check_adds_note_only_when_kb_is_silent(self):
        """Проверка базы — отдельный вызов: при «НЕТ» генератор получает указание, при «ЕСТЬ» запрос прежний."""
        seen = []

        def responder(verdict):
            def reply(messages):
                tail = messages[-1]["content"]
                if "Сейчас не отвечай клиенту" in tail:
                    return verdict
                seen.append("ПРОВЕРКА БАЗЫ" in tail)
                return "Ответ клиенту без чисел."
            return reply

        for verdict, noted in (("БЛИЖАЙШЕЕ В БАЗЕ: «…»\nВЕРДИКТ: НЕТ: срок хранения", True),
                               ("БЛИЖАЙШЕЕ В БАЗЕ: «…»\nВЕРДИКТ: ЕСТЬ", False)):
            seen.clear()
            with MockApi(reject_template_kwargs=False, responder=responder(verdict)) as mock:
                rows, _ = self._run(mock, [("1", "Сколько хранится история?")], extra_env={"EB_CHECK": "2"})
                calls = mock.calls["chat"]
            self.assertEqual((rows[0]["answer"], calls, seen), ("Ответ клиенту без чисел.", 2, [noted]))

    def test_ids_are_kept_exactly(self):
        questions = [(" a ", "Вопрос один?"), ("b", "Вопрос два?"), ("007", "Вопрос три?")]
        with MockApi(reject_template_kwargs=False) as mock:
            rows, _ = self._run(mock, questions)
        self.assertEqual([r["id"] for r in rows], [" a ", "b", "007"])

    def test_hard_deadline_with_dripping_response(self):
        """Ответ «капает» быстрее тайм-аута чтения, но бесконечно долго — файл всё равно пишется вовремя."""
        questions = [(str(i), f"Вопрос {i} про платформу учёта?") for i in range(4)]
        started = time.perf_counter()
        with MockApi(reject_template_kwargs=False, chat_drip=0.5) as mock:
            rows, log = self._run(mock, questions, extra_env={
                "EB_DEADLINE_SEC": "5", "EB_HARD_DEADLINE_SEC": "12", "MAX_WORKERS": "2"})
        elapsed = time.perf_counter() - started
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r["answer"].strip() for r in rows))
        self.assertIn("жёсткий дедлайн", log)
        self.assertLess(elapsed, 30, log[-400:])

    def test_llm_outage_still_gives_valid_submission(self):
        with MockApi(fail_chat=True) as mock:
            rows, _ = self._run(mock, [("1", "Вопрос один?"), ("2", "Вопрос два?")])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("специалист" in r["answer"] for r in rows))



class _Env:
    """Временные переменные окружения на время блока."""

    def __init__(self, **values):
        self.values, self.old = values, {}

    def __enter__(self):
        for k, v in self.values.items():
            self.old[k] = os.environ.get(k)
            os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self.old.items():
            os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)


class FactMapTest(unittest.TestCase):
    """Схема EB_ARCH=factmap: карта фактов + поиск по разделам + проверка чисел."""

    QUESTION = GuardTest.QUESTION
    GOOD = GuardTest.GOOD
    BAD = GuardTest.BAD

    def test_fact_map_is_built_from_kb(self):
        from energybot.factmap import fact_map_chunks, render_fact_map
        kb = KnowledgeBase.load(KB_DIR)
        text = render_fact_map(fact_map_chunks(kb))
        self.assertIn("Чего утверждать нельзя", text)
        self.assertIn("Факты, которые можно утверждать", text)
        self.assertIn("750", text)  # порог оптового рынка — из числовых показателей
        self.assertLess(len(text), 45000)  # карта — часть неизменного промпта, а не вся база

    def test_char_ngrams_find_section_by_word_form(self):
        from energybot.retrieval import Retriever
        kb = KnowledgeBase.load(KB_DIR)
        r = Retriever(kb, char_ngrams=True)
        hits = r.candidates("шиферной кровлей", n=5, char_query="шиферной кровлей")
        self.assertTrue(any("23-solar" in h.chunk.doc for h in hits), [h.chunk.path for h in hits])
        fm = {c.id for c in kb.chunks if c.is_guard}
        hits = r.candidates("чего утверждать нельзя солнечные", n=12, exclude=fm)
        self.assertFalse(any(h.chunk.id in fm for h in hits))

    def test_rerank_template_is_built_on_client(self):
        from energybot.retrieval import rerank_inputs
        q, docs = rerank_inputs("Вопрос?", ["Раздел"], "qwen")
        self.assertIn("<Instruct>:", q)
        self.assertIn("<Query>: Вопрос?", q)
        self.assertTrue(docs[0].startswith("<Document>: Раздел"))
        self.assertEqual(rerank_inputs("Вопрос?", ["Раздел"], "raw"), ("Вопрос?", ["Раздел"]))

    def _bot(self, mock):
        with _Env(EB_ARCH="factmap"):
            return _consultant(mock)

    def test_answer_uses_fact_map_and_sections(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: self.GOOD) as mock:
            result = self._bot(mock).answer(self.QUESTION)
            calls, messages = mock.calls["chat"], mock.last_messages
        self.assertEqual((result.text, calls), (self.GOOD, 1))
        self.assertIn("КАРТА ФАКТОВ", messages[0]["content"])
        self.assertIn("РАЗДЕЛЫ БАЗЫ ПО ВОПРОСУ", messages[1]["content"])
        self.assertTrue(result.sources)
        self.assertLessEqual(len(result.sources), 5)

    def test_invented_number_is_repaired(self):
        def responder(messages):
            return self.GOOD if messages[-1]["content"].startswith("[Служебная") else self.BAD

        with MockApi(reject_template_kwargs=False, responder=responder) as mock:
            result = self._bot(mock).answer(self.QUESTION)
        self.assertEqual(result.text, self.GOOD)
        self.assertEqual(result.guard["unknown_numbers"], ["3750000"])

    def test_short_reply_is_condensed_before_search(self):
        def responder(messages):
            if messages[0]["content"].startswith("Перепиши"):
                return "Подойдёт ли платформа учёта для СНТ на 300 кВт?"
            return self.GOOD

        dialog = "Пользователь: Мы СНТ, хотим учёт.\nАссистент: Какая мощность?\nПользователь: 300 кВт"
        with MockApi(reject_template_kwargs=False, responder=responder) as mock:
            result = self._bot(mock).answer(dialog)
            calls = mock.calls["chat"]
        self.assertEqual(calls, 2)
        self.assertIn("СНТ", result.guard["condensed"])
        self.assertEqual(result.text, self.GOOD)

    def test_single_question_is_not_condensed(self):
        with MockApi(reject_template_kwargs=False, responder=lambda m: self.GOOD) as mock:
            self._bot(mock).answer("Да")
            self.assertEqual(mock.calls["chat"], 1)

    def test_empty_answer_is_retried(self):
        state = {"n": 0}

        def responder(messages):
            state["n"] += 1
            return "<think>рассуждаю и не успеваю" if state["n"] == 1 else self.GOOD

        with MockApi(reject_template_kwargs=False, responder=responder) as mock:
            result = self._bot(mock).answer(self.QUESTION)
        self.assertEqual((result.text, state["n"]), (self.GOOD, 2))

    def test_llm_outage_gives_extract_from_kb(self):
        with MockApi(fail_chat=True) as mock:
            result = self._bot(mock).answer(self.QUESTION)
        self.assertTrue(result.text.strip())
        self.assertTrue(result.error)

    def test_full_run(self):
        questions = [("1", "Сколько стоит платформа учёта?"),
                     ("2", "Пользователь: Хотим на опт.\nАссистент: Какая мощность?\nПользователь: 800 кВт")]
        with MockApi(reject_template_kwargs=True) as mock:
            rows, log = SolutionEndToEndTest._run(self, mock, questions, extra_env={"EB_ARCH": "factmap"})
        self.assertEqual([r["id"] for r in rows], ["1", "2"])
        self.assertTrue(all(r["answer"].strip() for r in rows))
        self.assertIn("схема factmap", log)



class ExperimentsTest(unittest.TestCase):
    """Каналы и варианты, добавленные для экспериментов на 18 эталонах."""

    GOOD = GuardTest.GOOD

    def test_history_window_in_lexical_query(self):
        turns = parse("Пользователь: про солнце\nАссистент: ок\nПользователь: про опт\nАссистент: ок\n"
                      "Пользователь: про фото\nАссистент: ок\nПользователь: про учёт\nАссистент: ок\n"
                      "Пользователь: итог?")
        self.assertIn("солнце", search_queries(turns)[0])
        self.assertNotIn("солнце", search_queries(turns, window=3)[0])

    def test_parse_marks(self):
        from energybot.factmap import parse_marks
        self.assertEqual(parse_marks("0: 9\n1 - 3,5\n7: 10\n2: 15", 3), {0: 9.0, 1: 3.5, 2: 10.0})

    def test_jury_rules_are_selected(self):
        from energybot.prompts import build_messages
        msgs = build_messages("", "материалы", parse("Вопрос?"), style="jury", examples=False)
        self.assertIn("КОГДА ВОПРОС НЕ НУЖЕН", msgs[0]["content"])
        self.assertIn("30–60 слов", msgs[1]["content"])

    def _answer(self, env: dict, responder):
        with MockApi(reject_template_kwargs=False, responder=responder) as mock:
            with _Env(**env):
                bot = _consultant(mock)
            result = bot.answer("Можно ли поставить панели на шиферную крышу?")
            return result, mock

    def test_toc_selection_keeps_search(self):
        def responder(messages):
            if messages[0]["content"].startswith("Ты выбираешь разделы"):
                return "3, 5, 3, 9999"
            return self.GOOD
        result, _ = self._answer({"EB_ARCH": "factmap", "EB_FM_TOC": "1"}, responder)
        self.assertEqual(result.guard.get("toc"), 2)
        self.assertNotIn("full_kb", result.guard)
        self.assertEqual(result.text, self.GOOD)

    def test_llm_rerank_and_parent_doc(self):
        def responder(messages):
            if messages[0]["content"].startswith("Ты отбираешь разделы"):
                return "0: 2\n1: 10\n2: 7"
            return self.GOOD
        result, mock = self._answer({"EB_ARCH": "factmap", "EB_FM_LLMRERANK": "1", "EB_FM_PARENT": "1",
                                     "EB_FM_PROMPT": "jury"}, responder)
        self.assertEqual(result.guard.get("llm_rerank"), 3)
        self.assertIn("=== Документ", mock.last_messages[1]["content"])
        self.assertIn("КОГДА ВОПРОС НЕ НУЖЕН", mock.last_messages[0]["content"])

    def test_verify_ensemble_search_on_v3(self):
        result, mock = self._answer({"EB_SEARCH": "ve"}, lambda m: self.GOOD)
        self.assertEqual(result.text, self.GOOD)
        self.assertNotIn("=== Документ", mock.last_messages[1]["content"])  # фрагменты, а не документы целиком
        self.assertIn("СПРАВОЧНИК", mock.last_messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
