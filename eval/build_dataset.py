"""Сборка выборки из частей: eval/dataset/parts/*.jsonl → eval/dataset/cases.jsonl.

- прогоняет валидатор; кейсы с ошибками не попадают в сборку (список — в выводе);
- делит детерминированно на dev (≈70%) и holdout (≈30%) со стратификацией
  по области, категории и типу: на dev подгоняем бота, holdout смотрим редко.

    python eval/build_dataset.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

from validate_dataset import load_cases, validate  # noqa: E402

from energybot.kb import KnowledgeBase  # noqa: E402

DATASET = ROOT / "eval" / "dataset"
HOLDOUT_SHARE = 0.3


def main():
    parts = sorted((DATASET / "parts").glob("*.jsonl"))
    cases = load_cases(parts)
    errors, _ = validate(cases, KnowledgeBase.load(ROOT / "knowledge-base"))
    broken = {e.split(" ", 1)[0] for e in errors}
    good = [c for c in cases if "_error" not in c and c.get("id") not in broken]
    for c in good:
        c.pop("_where", None)
        c["area"] = c["id"].rsplit("-", 1)[0]

    groups = defaultdict(list)
    for c in good:
        groups[(c["area"], c["category"], c["type"])].append(c)
    for members in groups.values():
        # Порядок внутри группы — по хэшу id: стабильно при пересборке.
        members.sort(key=lambda c: hashlib.sha1(c["id"].encode()).hexdigest())
        n_hold = round(len(members) * HOLDOUT_SHARE)
        for i, c in enumerate(members):
            c["split"] = "holdout" if i < n_hold else "dev"

    good.sort(key=lambda c: c["id"])
    with open(DATASET / "cases.jsonl", "w", encoding="utf-8") as f:
        for c in good:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print(f"частей: {len(parts)}, кейсов: {len(cases)}, в сборке: {len(good)}, отбраковано: {len(cases) - len(good)}")
    if broken:
        print("отбракованы:", sorted(broken))
    print("split:", dict(Counter(c["split"] for c in good)))
    print("области:", dict(Counter(c["area"] for c in good)))
    print("категории:", dict(Counter(c["category"] for c in good).most_common()))
    print("типы:", dict(Counter(c["type"] for c in good)))


if __name__ == "__main__":
    main()
