"""«Честные нет» (T26): правила-несовместимости из базы (scripts/honest_no.py) и их место в ответе.

Без модели и без сети.

    python -m unittest tests.test_honest_no -v
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

import honest_no  # noqa: E402

from energybot.kb import KnowledgeBase  # noqa: E402
from energybot.pipeline import Answer  # noqa: E402

KB = KnowledgeBase.load(ROOT / "knowledge-base")
DIGITS = re.compile(r"\d+(?:[.,]\d+)?")


def user(*texts) -> list:
    """Диалог: реплики клиента, между ними — ответы консультанта (без фактов о клиенте)."""
    turns = []
    for i, t in enumerate(texts):
        if i:
            turns.append({"role": "assistant", "content": "Понял. Уточните, пожалуйста, детали."})
        turns.append({"role": "user", "content": t})
    return turns


# (диалог, паспорт, правила, которые должны сработать)
FIRES = [
    (user("Хотим выйти на оптовый рынок, присоединённая мощность 450 кВт"), None, {"orem_below_750"}),
    (user("Интересует ОРЭМ", "Присоединённая мощность около 600 кВт"), None, {"orem_below_750"}),
    (user("Можно ли нам на опт? У нас не больше 0,5 МВт"), None, {"orem_below_750"}),
    (user("Интересует выход на оптовый рынок"), {"connected_power": "300 кВт"}, {"orem_below_750"}),
    (user("Мы на Сахалине, интересует оптовый рынок электроэнергии"), None, {"orem_isolated_system"}),
    (user("Мы уже являемся участником оптового рынка, что вы можете предложить?"), None, {"orem_already_member"}),
    (user("У нас офис, можно выйти на оптовый рынок?"), None, {"orem_no_production_load"}),
    (user("Мы энергосбыт, нужен поиск хищений"), None, {"losses_sbyt"}),
    (user("У нас завод, хотим найти потери"), None, {"losses_industrial"}),
    (user("Мы сетевая компания, нужен поиск потерь", "Данные только за 6 месяцев"), None, {"losses_not_enough_data"}),
    (user("Сетевая компания. Для поиска потерь у нас только ежемесячные показания"), None, {"losses_not_enough_data"}),
    (user("Поиск коммерческих потерь можно развернуть на наших серверах?"), None, {"losses_on_premises"}),
    (user("Хочу солнечную станцию на частный дом"), None, {"solar_private_house"}),
    (user("Объект работает в основном ночью, подойдёт солнечная станция?"), None, {"solar_night_load"}),
    (user("Хотим солнечные панели на склад", "Кровля из шифера, ему 20 лет"), None, {"solar_old_slate"}),
    (user("Хотим солнечные панели, кровля — старый шифер"), None, {"solar_old_slate"}),
    (user("Нужна солнечная станция, чтобы при отключении сети был свет"), None, {"solar_grid_backup"}),
    (user("Платформа учёта сможет выставлять квитанции нашим абонентам?"), None, {"askue_billing"}),
    (user("Подключаем платформу учёта, нужен ещё энергоаудит"), None, {"askue_energy_audit"}),
    (user("Вы продаёте электроэнергию? Хотим покупать электроэнергию у вас"), None, {"mts_not_supplier"}),
]

# Данных нет, они неоднозначны или база говорит «может» — правила молчат.
SILENT = [
    user("Хотим выйти на оптовый рынок, что для этого нужно?"),  # мощность не названа
    user("Хотим на ОРЭМ, присоединённая мощность 1,2 МВт"),  # выше порога
    user("Хотим на ОРЭМ, присоединённая мощность 750 кВт"),  # ровно порог: «ниже 750» не выполнено
    user("Хотим на ОРЭМ, мощность больше 500 кВт"),  # нижняя граница — с порогом не сравнить
    user("Хотим на ОРЭМ, три площадки по 400 кВт"),  # мощности суммируются при электрической связности
    user("Хотим на оптовый рынок. Потребление 500 кВт·ч в месяц"),  # энергия, а не мощность
    user("Хотим на ОРЭМ. Ещё думаем о солнечной станции на 100 кВт"),  # мощность станции, не присоединённая
    user("У нас 450 кВт, нужна платформа учёта"),  # мощность есть, интереса к опту нет
    user("У нас производство и офис, интересует оптовый рынок"),  # есть производственная нагрузка
    user("Мы сетевая компания, нужен поиск потерь"),  # целевой клиент
    user("Мы энергосбыт, у нас на балансе сетевые организации, интересует поиск потерь"),  # исключение из базы
    user("Мы не завод, а сетевая организация; интересует поиск хищений"),
    user("Сетевая компания, поиск потерь, архив за 2 года"),  # архив не меньше года
    user("Хотим солнечные панели, кровля из шифера"),  # возраст не назван
    user("Хотим солнечные панели на крышу, шифер положили 3 года назад"),
    user("Хотим солнечные панели, кровля — шифер 2023 года"),
    user("Нужна гибридная солнечная станция с накопителями на случай отключений"),  # это и есть решение
    user("Солнечная станция для СНТ на дом правления"),  # товарищество — не частный дом
    user("Мы работаем круглосуточно, подойдёт солнечная станция?"),  # не «преимущественно ночью»
    user("Мы сами выставляем квитанции абонентам, нужна выгрузка из платформы учёта"),
    user("Мы уже провели энергоаудит в прошлом году"),  # рассказ, а не просьба
    user("Можно ли распознавать показания счётчиков газа и тепла?"),  # база: «может рассматриваться»
    user("Распознанное по фото показание можно сразу принимать в расчёты?"),  # база: «может, после верификации»
    user("Сколько стоит платформа учёта?"),
    user("Мы не хотим покупать электроэнергию у вас, интересует учёт"),
]


class RulesAreBackedByKnowledgeBase(unittest.TestCase):
    """Ограничение №1: каждое условие и число правила — в тексте базы."""

    @classmethod
    def setUpClass(cls):
        cls.by_path = {(c.doc, c.path): c for c in KB.chunks}

    def chunk(self, ref):
        c = self.by_path.get((ref.doc, ref.path))
        self.assertIsNotNone(c, f"нет раздела {ref.doc} | {ref.path}")
        return c

    def assert_backed(self, text: str, ref, what: str):
        source = honest_no.plain(self.chunk(ref).text)
        self.assertIn(honest_no.plain(text), source, f"{what}: текста нет в разделе {ref.path}")
        for number in DIGITS.findall(text):
            self.assertIn(number, DIGITS.findall(source), f"{what}: число {number} не из базы")

    def test_reason_and_alternatives_are_verbatim_kb_text(self):
        for rule in honest_no.RULES:
            self.assert_backed(rule.reason, rule.ref, rule.id)
            for alt in rule.alternatives:
                for part in alt.parts:
                    self.assert_backed(part, alt.ref, f"{rule.id}/альтернатива")

    def test_thresholds_are_in_kb(self):
        for t in honest_no.THRESHOLDS:
            source = honest_no.plain(self.chunk(t.ref).text)
            self.assertIn(honest_no.plain(t.text), source, t.name)
            digits = DIGITS.findall(t.text.replace("-", " "))
            if digits:
                self.assertIn(f"{t.value:g}", digits, f"{t.name}: порог {t.value:g} записан в базе иначе")
            else:  # «не менее года»: число словом — только единица
                self.assertEqual(t.value, 1, t.name)
        self.assertIn("750", honest_no.OREM_MIN_KW.text)

    def test_no_rule_is_disabled_on_current_kb(self):
        self.assertEqual(honest_no.Detector(KB).disabled, [])

    def test_rule_without_kb_support_is_disabled(self):
        changed = [c for c in KB.chunks if c.path != honest_no.OREM_MIN_KW.ref.path]
        detector = honest_no.Detector(KnowledgeBase(changed, "x"))
        self.assertIn("orem_below_750", detector.disabled)
        self.assertEqual(detector.detect(FIRES[0][0]), [], "без раздела базы плашки нет")

    def test_no_money_in_rules(self):
        for rule in honest_no.RULES:
            texts = [rule.reason] + [p for a in rule.alternatives for p in a.parts]
            for t in texts:
                # «расчёты в рублях» — условие базы, а сумм, сроков окупаемости и процентов экономии нет.
                self.assertNotRegex(t.lower(), r"\d[\d\s,.]*(?:руб|₽|тыс|млн|%|процент)|окупа", rule.id)


class RulesFireOnDialogs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.detector = honest_no.Detector(KB)

    def test_fires_on_synthetic_dialogs(self):
        for turns, passport, expected in FIRES:
            got = {x["rule"] for x in self.detector.detect(turns, passport)}
            self.assertEqual(got, expected, turns[-1]["content"])

    def test_every_rule_has_a_firing_case(self):
        covered = set().union(*(e for _, _, e in FIRES))
        self.assertEqual(covered, {r.id for r in honest_no.RULES})

    def test_silent_without_data_or_when_kb_says_may(self):
        for turns in SILENT:
            self.assertEqual(self.detector.detect(turns), [], turns[-1]["content"])

    def test_payload_shape_and_kb_link(self):
        [item] = self.detector.detect(user("Мы энергосбыт, нужен поиск хищений"))
        self.assertEqual(set(item), {"rule", "product", "reason", "fact", "section", "alternative"})
        self.assertEqual(item["product"], "Поиск коммерческих потерь")
        self.assertEqual(item["fact"], "энергосбыт")
        ids = {c.id for c in KB.chunks}
        self.assertIn(item["section"]["chunk_id"], ids)
        self.assertEqual(item["section"]["doc"], "20-products/24-losses.md")
        self.assertIn("Исключение возможно", item["reason"], "оговорка базы входит в причину: не категоричнее базы")
        self.assertIn("Распознавание показаний по фото", item["alternative"]["text"])
        self.assertIn(item["alternative"]["section"]["chunk_id"], ids)
        [region] = self.detector.detect(user("Мы на Сахалине, интересует оптовый рынок"))
        self.assertEqual(region["fact"], "Сахалине", "фрагмент — как написал клиент, а не нормализованный")

    def test_alternative_depends_on_client(self):
        mall = self.detector.detect(user("У нас торговый центр, интересует оптовый рынок"))
        self.assertIn("арендаторам", mall[0]["alternative"]["text"])
        office = self.detector.detect(user("У нас офис, интересует оптовый рынок"))
        self.assertIsNone(office[0]["alternative"], "для офиса база альтернативы не называет — не выдумываем")

    def test_only_client_turns_count(self):
        turns = [
            {"role": "user", "content": "Хотим выйти на оптовый рынок"},
            {"role": "assistant", "content": "Ниже 750 кВт выход невозможен. У вас 450 кВт или больше?"},
            {"role": "user", "content": "Пока не знаю"},
        ]
        self.assertEqual(self.detector.detect(turns), [], "число из реплики консультанта — не факт о клиенте")

    def test_not_repeated_on_unrelated_turn(self):
        first = user("Мы энергосбыт, нужен поиск хищений")
        self.assertTrue(self.detector.detect(first))
        later = user("Мы энергосбыт, нужен поиск хищений", "А сколько стоит платформа учёта?")
        self.assertEqual(self.detector.detect(later), [], "плашка — под ответом на реплику о продукте")

    def test_passport_is_a_source_of_facts(self):
        view = {"fields": [{"key": "org_type", "value": "энергосбытовая компания"},
                           {"key": "company", "value": "ООО Учебный склад"}]}
        got = self.detector.detect(user("Интересует поиск потерь"), view)
        self.assertEqual([x["rule"] for x in got], ["losses_sbyt"])
        # Название компании — не тип организации; контакты в детектор не идут.
        named = {"company": "ООО Энергосбыт Тестовый", "phone": "+7 900 000-00-00"}
        self.assertEqual(self.detector.detect(user("Интересует поиск потерь"), named), [])
        self.assertEqual(self.detector.detect(user("Интересует поиск потерь"), "не словарь"), [])


class ChatOnly(unittest.TestCase):
    def test_block_only_in_chat_prompt(self):
        """Режим автопроверки не меняется: блок «честных нет» не попадает ни в один eval-промпт."""
        from energybot.factmap import build_fm_messages
        from energybot.prompts import HONEST_NO_MODE, build_messages, build_write_messages
        block = HONEST_NO_MODE.strip()
        turns = user("Мы энергосбыт, нужен поиск хищений")
        for style in ("tight", "full", "recipe", "jury", "jury2"):
            for plan in (0, 1, 2):
                for full_kb in (False, True):
                    msgs = build_messages("СПР", "МАТ", turns, "eval", style=style, plan=plan, full_kb=full_kb, near=2)
                    self.assertNotIn(block, "\n".join(m["content"] for m in msgs), style)
                    self.assertNotIn("ЧЕСТНОЕ «НЕ ПОДОЙДЁТ»", "\n".join(m["content"] for m in msgs), style)
            chat = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", turns, "chat", style=style))
            self.assertIn(block, chat, style)
            copilot = "\n".join(m["content"] for m in build_messages("СПР", "МАТ", turns, "copilot", style=style))
            self.assertNotIn(block, copilot, style)
        for builder in (lambda m: build_write_messages("МАТ", turns, "черновик", m),
                        lambda m: build_fm_messages("КАРТА", "МАТ", turns, m)):
            self.assertNotIn(block, "\n".join(x["content"] for x in builder("eval")))
            self.assertIn(block, "\n".join(x["content"] for x in builder("chat")))
        self.assertIn("скорее всего, не подойдёт", block)
        self.assertIn("Не отговаривай, если база говорит «может»", block)

    def test_answer_event_carries_honest_no_only_in_chat(self):
        api = core_api.WebApi()
        api.base_url = ""  # без модели и без сети, даже если в .env есть ключ
        with mock.patch.dict(os.environ, {"EB_INDEX_CACHE_DIR": "", "EB_CONFIDENCE_GATE": "0"}):
            app = core_api.App(api)
        app.bot.answer = lambda turns, mode="eval", **kw: Answer("Поиск потерь решает задачу сетевой компании.", [],
                                                                 {"total": 0.0})
        body = {"messages": user("Мы энергосбыт, нужен поиск хищений")}
        chat = app.chat(body | {"mode": "chat"}, lambda *a: None)
        self.assertEqual([x["rule"] for x in chat["honest_no"]], ["losses_sbyt"])
        for mode in ("eval", "copilot"):
            self.assertEqual(app.chat(body | {"mode": mode}, lambda *a: None)["honest_no"], [], mode)
        with_passport = app.chat({"messages": user("Интересует оптовый рынок"), "mode": "chat",
                                  "passport": {"connected_power": "300 кВт"}}, lambda *a: None)
        self.assertEqual([x["rule"] for x in with_passport["honest_no"]], ["orem_below_750"])


if __name__ == "__main__":
    unittest.main()
