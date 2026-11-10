"""Классификация неоднозначности перед генерацией ответа (8 типов, вывод — 4 поля).

Модель решает, что известно и чего не хватает; конвейер решает, что с этим делать.
Принципы из эталонов жюри: ответ никогда не блокируется (кроме неизвестного предмета),
ветвящиеся неопределённости снимаются условным ответом + одним вопросом, по теме
вне базы вопросов не задаём.
"""

from __future__ import annotations

import json
import re
import sys

from .llm import env, env_num

# Тип и поведение. blocking бывает только у no_subject.
TYPES = {
    "no_subject": "непонятно, о каком продукте/задаче речь, и история не помогает",
    "goal_branch": "от цели меняется рекомендация (экономия vs резерв, общий учёт vs по арендаторам)",
    "topology_branch": "от размещения/топологии меняется решение (кровля/земля/фасад, площадка или сеть)",
    "regulation_branch": "от региона/мощности меняется допустимость (изолированные сети, пороги)",
    "calc_missing": "просят число, а входных для расчёта нет",
    "units_conflict": "единицы смешаны или противоречат (кВт vs кВт·ч, месяц vs год)",
    "out_of_kb": "нужного факта нет в материалах",
    "none": "всё есть для прямого ответа",
}

PROMPT = """Ты — классификатор неоднозначности консультанта МТС EnergyTool. Не отвечай клиенту, не выдумывай, не считай.

Типы (выбери РОВНО один):
- no_subject: непонятно, о каком продукте/задаче речь, и история не помогает
- goal_branch: от цели меняется рекомендация (экономия vs резерв, общий учёт vs по арендаторам)
- topology_branch: от размещения/топологии меняется решение (кровля/земля/фасад, площадка или сеть)
- regulation_branch: от региона/мощности меняется допустимость (изолированные сети, пороги 670/750 кВт)
- calc_missing: просят число/расчёт, а входных данных нет
- units_conflict: единицы смешаны или противоречат
- out_of_kb: нужного факта нет в материалах
- none: всё есть для прямого ответа

Правила:
1. По умолчанию none — сначала ищи причину НЕ спрашивать.
2. Вопрос задавай только если ответ на него изменит следующий шаг консультанта.
3. Не спрашивай то, что клиент уже сказал, и то, что ассистент уже спрашивал.
4. Вопрос короткий, без чисел и контактов, заканчивается «?».
5. При out_of_kb вопрос не задаётся.

Верни строго JSON без пояснений:
{"type": "...", "known": {"слот": "значение"}, "missing": ["слот"], "question": "...? или пустая строка"}"""


def fallback_decision(turns: list) -> dict:
    return {"type": "none", "known": {}, "missing": [], "question": ""}


def _valid_question(question: str, turns: list) -> bool:
    q = " ".join(question.split())
    if not q.endswith("?") or len(q) > 120 or re.search(r"\d", q):
        return False
    if re.search(r"телефон|фио|контакт|e-?mail|почт", q, re.I):
        return False
    previous = " ".join(t["content"].lower() for t in turns if t["role"] == "assistant")
    return q.lower() not in previous


def normalize_decision(data: dict, turns: list) -> dict:
    if not isinstance(data, dict) or data.get("type") not in TYPES:
        return fallback_decision(turns)
    question = str(data.get("question") or "").strip()
    if question and not _valid_question(question, turns):
        question = ""
    return {
        "type": data["type"],
        "known": {str(k): str(v) for k, v in (data.get("known") or {}).items()},
        "missing": [str(m) for m in data.get("missing") or []][:3],
        "question": question,
    }


class AmbiguityClassifier:
    def __init__(self, api):
        self.api = api

    def classify(self, turns: list, materials: str, fast: bool = False) -> dict:
        if fast or not self.api.configured or env("EB_AMBIGUITY", "0") == "0":
            return fallback_decision(turns)
        # Явный расчёт не отдаём классификатору — его детерминированно забирает calc.py.
        last = next((t["content"] for t in reversed(turns) if t["role"] == "user"), "")
        dialog = "\n".join(f"{'Клиент' if t['role'] == 'user' else 'Ассистент'}: {t['content']}"
                           for t in turns[-6:])[:4500]
        user = f"РЕПЛИКИ:\n{dialog}\n\nМАТЕРИАЛЫ ДЛЯ КОНТЕКСТА:\n{materials[:5000]}"
        try:
            raw = self.api.chat([{"role": "system", "content": PROMPT}, {"role": "user", "content": user}],
                                max_tokens=env_num("EB_AMBIGUITY_TOKENS", 400, 128, 900))
            match = re.search(r"\{.*\}", raw, re.S)
            data = json.loads(match.group(0)) if match else {}
            return normalize_decision(data, turns)
        except Exception as exc:  # noqa: BLE001
            print(f"[ambiguity] сбой классификатора: {exc}", file=sys.stderr)
            return fallback_decision(turns)


def decision_note(decision: dict) -> str:
    """Строка в системный промпт по решению классификатора."""
    t = decision.get("type", "none")
    if t == "none":
        return ""
    if t == "no_subject":
        return "Предмет вопроса неясен даже с историей: дай короткий общий ответ о том, чем помогаешь, и спроси, какая задача у клиента."
    if t == "out_of_kb":
        return "Нужного факта в материалах нет: скажи это прямо и предложи специалиста. Уточняющий вопрос не задавай."
    if t == "calc_missing" and decision.get("missing"):
        return ("Клиент просит число, но входных не хватает. НЕ считай сам. Скажи, что нужен расчёт по данным, "
                "и спроси ровно недостающее: " + ", ".join(decision["missing"]) + ".")
    if decision.get("question"):
        return ("Ответь по существу (при ветвлении — условно: «если… то…»), затем закончи этим уточняющим "
                "вопросом своими словами, по той же теме: «" + decision["question"] + "»")
    return ""
