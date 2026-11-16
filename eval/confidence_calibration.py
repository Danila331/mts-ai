"""Калибровка порога уверенности (T12) на проверочной выборке — без платных вызовов.

Считает retrieval-часть уверенности ядра стенда (scripts/core_api.py, retrieval_confidence) для каждого кейса
eval/dataset/cases.jsonl, печатает распределение по категориям и таблицу порогов для класса «ответа в базе нет»
(категории out-of-kb и out-of-scope) против всех остальных: порог по максимуму F1 и осторожный порог, при котором
в уточнение уходит не больше 5 % вопросов с ответом в базе. Предлагается осторожный: при слабом различении
максимум F1 отправляет в уточнение треть хороших вопросов.

Оговорки — читать до того, как включать гейт:
- Поиск офлайн: BM25 (+ RRF одного канала), без эмбеддингов и без реранкера. Модель не вызывается вообще:
  Api ядра обнулён, ключи из .env не используются. Реранкер — платный API, поэтому калибровки с ним нет; с
  реранкером retrieval-часть — среднее с его оценкой, шкала другая, и порог нужно подбирать заново.
- Порог подобран на dev; holdout для подбора не используется (правило AGENTS.md).
- Гейт в чате выключен по умолчанию (EB_CONFIDENCE_GATE=0). Автопроверка (solution.py, режим eval) гейта не
  видит при любых флагах. Включать что-то подобное в автопроверке — отдельное решение после
  `eval/run_eval.py --with-demo --baseline` с цифрами «до/после» (платный прогон, этот скрипт его не делает).

    python eval/confidence_calibration.py [--split dev|holdout|all] [--verbose]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# core_api при импорте читает .env и ставит свои умолчания: возвращаем окружение как было, чтобы настройки
# поиска (EB_TOP_K, EB_SEARCH …) были теми, с которыми запущен скрипт, а ключи из .env не попали в Api.
_saved_env = dict(os.environ)
import core_api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)

from energybot.dialog import parse  # noqa: E402

NO_ANSWER = {"out-of-kb", "out-of-scope"}
MAX_FALSE_GATE = 0.05  # осторожный порог: не больше 5 % вопросов с ответом в базе уходят в уточнение


def load_cases(path: Path, split: str) -> list:
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [c for c in cases if split == "all" or c.get("split") == split]


def offline_bot(kb: Path):
    """Консультант стенда без модели: Api обнулён до построения поиска — ни эмбеддингов, ни реранкера."""
    api = core_api.WebApi()
    api.base_url = ""
    api.can_rerank = False
    return core_api.WebConsultant(kb, api=api)


def score_cases(bot, cases: list) -> list:
    rows = []
    for c in cases:
        core_api.TRACE.reset()
        turns = parse(c["question"])
        bot.retrieve(turns)
        conf = core_api.TRACE.confidence
        rows.append({"id": c["id"], "category": c["category"], "score": conf["score"], "parts": conf["parts"],
                     "none": c["category"] in NO_ANSWER})
    return rows


def quantile(values: list, q: float) -> float:
    values = sorted(values)
    pos = (len(values) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (pos - lo)


def sweep(rows: list) -> list:
    """(порог, precision, recall, F1, доля отвечаемых под порогом) — «ответа нет», если score < порога."""
    out = []
    for t in sorted({round(r["score"] + 0.0005, 4) for r in rows} | {0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4}):
        flagged = [r for r in rows if r["score"] < t]
        tp = sum(r["none"] for r in flagged)
        pos = sum(r["none"] for r in rows)
        answerable = len(rows) - pos
        precision = tp / len(flagged) if flagged else 0.0
        recall = tp / pos if pos else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        out.append((t, precision, recall, f1, (len(flagged) - tp) / answerable if answerable else 0.0))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "dataset" / "cases.jsonl"))
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "all"])
    ap.add_argument("--kb", default=str(ROOT / "knowledge-base"))
    ap.add_argument("--verbose", action="store_true", help="уверенность каждого кейса «ответа нет»")
    args = ap.parse_args()

    bot = offline_bot(Path(args.kb))
    rows = score_cases(bot, load_cases(Path(args.dataset), args.split))
    print(f"\nretrieval-уверенность (офлайн: BM25, без эмбеддингов и реранкера), сплит {args.split}, "
          f"кейсов: {len(rows)}, разделов в оценке: top-{core_api.CONFIDENCE_TOP}")
    print(f"{'категория':14s} {'n':>4s} {'мин':>6s} {'q25':>6s} {'медиана':>8s} {'q75':>6s} {'макс':>6s}")
    for cat in sorted({r["category"] for r in rows}, key=lambda c: (c in NO_ANSWER, c)):
        v = [r["score"] for r in rows if r["category"] == cat]
        mark = "  ← ответа в базе нет" if cat in NO_ANSWER else ""
        print(f"{cat:14s} {len(v):4d} {min(v):6.2f} {quantile(v, .25):6.2f} {statistics.median(v):8.2f} "
              f"{quantile(v, .75):6.2f} {max(v):6.2f}{mark}")

    neg = [r["score"] for r in rows if r["none"]]
    pos = [r["score"] for r in rows if not r["none"]]
    if not neg or not pos:
        print("\nнет одного из классов — порог не подобрать")
        return
    auc = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))
    print(f"\nответа нет: {len(neg)}, медиана {statistics.median(neg):.2f}; остальные: {len(pos)}, "
          f"медиана {statistics.median(pos):.2f}; ROC AUC (остальные выше) {auc:.3f}")

    table = sweep(rows)
    best = max(table, key=lambda x: (x[3], -x[4]))
    print("\nпорог  precision  recall    F1  отвечаемых под порогом")
    for t, p, r, f1, fpr in table:
        if t in (0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4) or t == best[0]:
            mark = "  ← максимум F1" if t == best[0] else ""
            print(f"{t:5.3f}  {p:9.2f}  {r:6.2f}  {f1:4.2f}  {fpr:22.2f}{mark}")
    # Осторожный порог: самый высокий, при котором под порог попадает не больше 5 % вопросов, ответ на которые
    # в базе есть. Отказ на хорошем вопросе в чате дороже пропущенного «ответа нет» (его ловят промпт и guard).
    safe = max((x for x in table if x[4] <= MAX_FALSE_GATE), key=lambda x: x[0], default=table[0])
    print(f"\nпорог по максимуму F1: {best[0]:.2f} — precision {best[1]:.2f}, recall {best[2]:.2f}, "
          f"под порогом {best[4]:.0%} вопросов с ответом в базе")
    print(f"осторожный порог (под порогом ≤ {MAX_FALSE_GATE:.0%} вопросов с ответом): {safe[0]:.2f} — "
          f"precision {safe[1]:.2f}, recall {safe[2]:.2f}")
    t = safe[0]
    print(f"предложенный порог: EB_CONFIDENCE_THRESHOLD={t:.2f} (по умолчанию в ядре — {core_api.CONFIDENCE_THRESHOLD})")
    print("доля под порогом по категориям:", ", ".join(
        f"{cat} {sum(r['score'] < t for r in rows if r['category'] == cat)}/"
        f"{sum(r['category'] == cat for r in rows)}" for cat in sorted({r['category'] for r in rows})))
    print("оговорка: без реранкера; различение слабое — гейт остаётся выключенным по умолчанию, "
          "включение в автопроверке — только после run_eval --with-demo --baseline.")
    if args.verbose:
        print()
        for r in sorted(rows, key=lambda r: r["score"]):
            if r["none"] or r["score"] < t:
                print(f"{r['score']:.2f} {'НЕТ ' if r['none'] else 'есть'} [{r['id']}] {r['parts'][0]['detail']}")


if __name__ == "__main__":
    main()
