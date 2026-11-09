"""Проверка проверочной выборки (формат — eval/dataset/SPEC.md).

Ошибки (кейс бракуется):
- нарушена схема, неизвестная категория, кривой формат диалога;
- раздел из sources не существует в базе;
- в эталоне есть число, которого нет ни в цитируемых разделах, ни в вопросе;
- regex из must не находится в самом эталоне или must_not находится.
Предупреждения: длина, markdown, просьба контактов, почти-дубликаты вопросов.

    python eval/validate_dataset.py eval/dataset/parts/*.jsonl
    python eval/validate_dataset.py eval/dataset/cases.jsonl --quiet
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.dialog import parse  # noqa: E402
from energybot.kb import KnowledgeBase  # noqa: E402
from energybot.text import tokens  # noqa: E402

CATEGORIES = {"faq", "fact", "fit", "trap", "consult", "out-of-kb", "out-of-scope", "adversarial"}
REQUIRED = {"id": str, "category": str, "type": str, "question": str, "reference": str,
            "sources": list, "must": list, "must_not": list}
NUMBER = re.compile(r"\d+(?:[  ]\d{3})*(?:[.,]\d+)?")


CLAUSE_NEGATION = re.compile(r"\b(не|нет|нельзя|ни|никак\w*)\b", re.I)
PATTERN_NEGATION = re.compile(r"(^|[^а-яё\w])(не|нет|нельзя|без|невозмож|недоступ)", re.I)


def violates(pattern: str, text: str) -> bool:
    """Нарушение must_not с учётом отрицания.

    Запрет вида «гарантируем» не нарушен ответом «не гарантируем»: совпадение
    не считается, если в той же фразе есть отрицание. Строго (без этой поблажки)
    проверяются якорные запреты (^да) и запреты, где отрицание — сама ошибка.
    """
    strict = pattern.startswith("^") or PATTERN_NEGATION.search(pattern)
    for m in re.finditer(pattern, text, re.I | re.M):
        if strict:
            return True
        start = max(text.rfind(ch, 0, m.start()) for ch in ".!?;\n") + 1
        ends = [i for i in (text.find(ch, m.end()) for ch in ".!?;\n") if i != -1]
        clause = text[start:min(ends) if ends else len(text)]
        if not CLAUSE_NEGATION.search(clause):
            return True
    return False


def norm_numbers(text: str) -> set:
    return {re.sub(r"[  ]", "", m).replace(",", ".") for m in NUMBER.findall(text)}


def load_cases(paths: list) -> list:
    cases = []
    for p in paths:
        for n, line in enumerate(Path(p).read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                case = {"_error": f"{p}:{n}: битый JSON: {exc}"}
            case["_where"] = f"{Path(p).name}:{n}"
            cases.append(case)
    return cases


def validate(cases: list, kb: KnowledgeBase) -> tuple:
    sections = {(c.doc, c.path): c.text for c in kb.chunks}
    errors, warnings = [], []
    seen_ids = Counter(c.get("id") for c in cases)
    token_sets = []

    for case in cases:
        where = f"{case.get('id', '?')} ({case['_where']})"
        if "_error" in case:
            errors.append(case["_error"])
            continue
        bad = [k for k, t in REQUIRED.items() if not isinstance(case.get(k), t)]
        if bad:
            errors.append(f"{where}: нет/неверный тип полей {bad}")
            continue
        if seen_ids[case["id"]] > 1:
            errors.append(f"{where}: повторяется id")
        if case["category"] not in CATEGORIES:
            errors.append(f"{where}: неизвестная категория {case['category']}")
        q, ref = case["question"].strip(), case["reference"].strip()
        turns = parse(q)
        if case["type"] == "dialog":
            if not q.startswith("Пользователь:") or len(turns) < 3 or turns[-1]["role"] != "user" \
                    or q.rstrip().splitlines()[-1].startswith("Ассистент:"):
                errors.append(f"{where}: диалог должен начинаться с «Пользователь:», иметь ≥3 реплик и кончаться репликой пользователя")
        elif case["type"] == "single":
            if len(turns) != 1:
                errors.append(f"{where}: single-вопрос содержит роли")
        else:
            errors.append(f"{where}: type должен быть single или dialog")

        cited = []
        for s in case["sources"]:
            key = (s.get("doc"), s.get("section")) if isinstance(s, dict) else (None, None)
            if key not in sections:
                errors.append(f"{where}: нет раздела {key}")
            else:
                cited.append(sections[key])
        if not case["sources"] and case["category"] not in ("out-of-kb", "out-of-scope", "adversarial"):
            errors.append(f"{where}: нет sources")

        allowed = norm_numbers(" ".join(cited) + " " + q)
        unknown = sorted(n for n in norm_numbers(ref) - allowed if not (n.isdigit() and int(n) <= 2))
        if unknown:
            errors.append(f"{where}: числа {unknown} нет в цитируемых разделах и вопросе")

        for pattern in case["must"]:
            try:
                if not re.search(pattern, ref, re.I):
                    errors.append(f"{where}: must /{pattern}/ не находится в самом эталоне")
            except re.error as exc:
                errors.append(f"{where}: битый regex /{pattern}/: {exc}")
        for pattern in case["must_not"]:
            try:
                if violates(pattern, ref):
                    errors.append(f"{where}: must_not /{pattern}/ находится в самом эталоне")
            except re.error as exc:
                errors.append(f"{where}: битый regex /{pattern}/: {exc}")

        words = len(ref.split())
        if words > 90:
            errors.append(f"{where}: эталон {words} слов (максимум 90)")
        elif words < 15 or words > 70:
            warnings.append(f"{where}: эталон {words} слов (цель 25–60)")
        if re.search(r"\*\*|^\s*[-#]|\n", ref, re.M):
            warnings.append(f"{where}: markdown или переносы в эталоне")
        if re.search(r"\b(телефон|фио|контакт)", ref, re.I) and "не нуж" not in ref.lower():
            warnings.append(f"{where}: эталон просит контакты")
        if re.match(r"(здравствуйте|добрый день|привет)", ref, re.I):
            warnings.append(f"{where}: приветствие в эталоне")
        token_sets.append((case["id"], set(tokens(turns[-1]["content"]))))

    # Почти-дубликаты по последней реплике.
    for i in range(len(token_sets)):
        a_id, a = token_sets[i]
        for b_id, b in token_sets[i + 1:]:
            if a and b and len(a & b) / len(a | b) >= 0.8:
                warnings.append(f"{a_id} ~ {b_id}: почти одинаковые вопросы")
    return errors, warnings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--quiet", action="store_true", help="не печатать предупреждения")
    args = ap.parse_args()
    kb = KnowledgeBase.load(ROOT / "knowledge-base")
    cases = load_cases(args.paths)
    errors, warnings = validate(cases, kb)
    ok = [c for c in cases if "_error" not in c]
    print(f"кейсов: {len(cases)}")
    print("по категориям:", dict(Counter(c.get("category") for c in ok).most_common()))
    print("по типам:", dict(Counter(c.get("type") for c in ok)))
    print("эталон, слов (медиана):", sorted(len(c.get("reference", "").split()) for c in ok)[len(ok) // 2] if ok else 0)
    print("заканчивается вопросом:", f"{100 * sum(c.get('reference', '').rstrip().endswith('?') for c in ok) // max(1, len(ok))}%")
    if not args.quiet:
        for w in warnings:
            print("ПРЕДУПРЕЖДЕНИЕ", w)
    for e in errors:
        print("ОШИБКА", e)
    print(f"\nошибок: {len(errors)}, предупреждений: {len(warnings)}")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
