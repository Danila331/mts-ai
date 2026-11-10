"""Слепое судейство «человеком» или ИИ-агентом по методике платформы.

Зачем: судья не должен знать, какой ответ наш. Каждый вопрос предъявляется дважды,
как на платформе (раунд 1: A — бейзлайн, B — команда; раунд 2: наоборот), но записи
перемешаны, получают случайные коды и разнесены по пакетам, а ключ лежит отдельно.

    # 1) пакеты для судей из готового прогона run_eval (нужны bot/ и baseline/ или кэш бейзлайна)
    python eval/blind_judge.py export eval/reports/<время> --parts 8 [--baseline-pred eval/baseline/answers.csv]
    # 2) судьи заполняют verdicts-XX.jsonl рядом с пакетами
    # 3) подсчёт
    python eval/blind_judge.py score eval/reports/<время> [--baseline-pred ...]

Оба раунда одного вопроса всегда попадают в разные пакеты. В CI ключ кладётся отдельно
(--key) и судьям не передаётся.

Формат вердикта (одна строка JSON на запись пакета):
    {"pid": "k3f9a1", "verdict": "B_much_better|B_better|equal|A_better|A_much_better", "reason": "..."}
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from run_eval import PAIR_PROMPT, VERDICT_SCORE, breakdown, platform_metrics  # noqa: E402

RUBRIC = PAIR_PROMPT.split("Верни строго JSON")[0].strip()


def read_answers(path: Path) -> dict:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {r["id"]: r["answer"] for r in csv.DictReader(f)}


def load_cases() -> dict:
    cases = {}
    for line in (ROOT / "eval/dataset/cases.jsonl").read_text(encoding="utf-8").splitlines():
        c = json.loads(line)
        cases[c["id"]] = c
    with open(ROOT / "demo_questions.csv", encoding="utf-8-sig", newline="") as f:
        questions = {r["id"].strip(): r["question"] for r in csv.DictReader(f)}
    with open(ROOT / "demo_output.csv", encoding="utf-8-sig", newline="") as f:
        golden = {r["id"].strip(): r["answer"] for r in csv.DictReader(f)}
    for qid, q in questions.items():
        cases[f"demo-{qid}"] = {"id": f"demo-{qid}", "question": q, "reference": golden.get(qid, ""),
                                "category": "demo", "area": "demo",
                                "type": "dialog" if "Ассистент:" in q else "single"}
    return cases


def baseline_path(report: Path, baseline_pred: str | None) -> Path:
    return Path(baseline_pred) if baseline_pred else report / "baseline" / "submission.csv"


def export(report: Path, parts: int, seed: int, baseline_pred: str | None = None, key_path: str | None = None,
           out_dir: str | None = None):
    bot = read_answers(report / "bot" / "submission.csv")
    base = read_answers(baseline_path(report, baseline_pred))
    cases = load_cases()
    ids = [i for i in bot if base.get(i) and cases.get(i, {}).get("reference")]
    missing = [i for i in bot if not base.get(i)]
    if missing:
        print(f"нет ответа бейзлайна для {len(missing)} вопросов (например {missing[:3]}) — они пропущены", file=sys.stderr)
    rng = random.Random(seed)
    rng.shuffle(ids)
    parts = max(1, min(parts, len(ids)))
    packets = [[] for _ in range(parts)]
    key = {}
    for i, qid in enumerate(ids):
        for rnd in (1, 2):
            pid = f"{rng.getrandbits(32):08x}"
            team_side = "B" if rnd == 1 else "A"  # раунд 1: A — бейзлайн; раунд 2: A — команда
            a, b = (base[qid], bot[qid]) if rnd == 1 else (bot[qid], base[qid])
            # Раунды одного вопроса — в разные пакеты: судья не видит «зеркальных» пар.
            n = i % parts if rnd == 1 else (i + max(1, parts // 2)) % parts
            packets[n].append({"pid": pid, "question": cases[qid]["question"],
                               "reference": cases[qid]["reference"], "A": a, "B": b})
            key[pid] = {"id": qid, "round": rnd, "team": team_side}
    out = Path(out_dir) if out_dir else report / "blind"
    out.mkdir(parents=True, exist_ok=True)
    key_file = Path(key_path) if key_path else out / "key.json"
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_text(json.dumps(key, ensure_ascii=False, indent=1), encoding="utf-8")
    for n, chunk in enumerate(packets):
        rng.shuffle(chunk)
        if not chunk:
            continue
        lines = [f"# Пакет {n + 1:02d} — слепое сравнение ответов ({len(chunk)} записей)\n",
                 RUBRIC, "",
                 "Оценивай каждую запись независимо. Тебе не сообщают, кто автор ответов A и B.",
                 f"Результат запиши в `verdicts-{n + 1:02d}.jsonl` в этой же папке: по одной строке JSON на запись,",
                 '`{"pid": "...", "verdict": "B_much_better|B_better|equal|A_better|A_much_better", "reason": "одна фраза"}`.',
                 ""]
        for e in chunk:
            lines += [f"## pid {e['pid']}", "", "**Вопрос клиента:**", "", e["question"], "",
                      "**Эталонный ответ:**", "", e["reference"], "", "**Ответ A:**", "", e["A"], "",
                      "**Ответ B:**", "", e["B"], ""]
        (out / f"packet-{n + 1:02d}.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(ids)} вопросов → {2 * len(ids)} записей в {parts} пакетах: {out}; ключ: {key_file}")


def score(report: Path, baseline_pred: str | None = None, key_path: str | None = None,
          verdicts_dir: str | None = None, min_score: float | None = None) -> float | None:
    out = Path(verdicts_dir) if verdicts_dir else report / "blind"
    key = json.loads(Path(key_path or out / "key.json").read_text(encoding="utf-8"))
    rounds, bad = {}, 0
    for path in sorted(out.glob("verdicts-*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            v = json.loads(line)
            k = key.get(v.get("pid"))
            if not k or v.get("verdict") not in VERDICT_SCORE:
                bad += 1
                continue
            b_score = VERDICT_SCORE[v["verdict"]]
            team = b_score if k["team"] == "B" else 1 - b_score
            rounds.setdefault(k["id"], {})[k["round"]] = (team, v.get("reason", ""))
    cases = load_cases()
    per_q = {qid: (r[1][0] + r[2][0]) / 2 for qid, r in rounds.items() if 1 in r and 2 in r}
    m = platform_metrics(list(per_q.values()))
    lines = [f"# Слепое судейство — {report.name}\n",
             f"Вопросов с двумя раундами: {m['n']} (непарных: {len(rounds) - len(per_q)}, битых строк: {bad})\n"]
    if m["n"]:
        lines.append(f"**Score = {m['score']:.3f}** (0,7 × Match Rate {m['match_rate']:.3f} + 0,3 × Win Rate "
                     f"{m['win_rate']:.3f}); побед {m['wins']}, ничьих {m['ties']}, поражений {m['losses']}\n")
    items = {qid: cases[qid] for qid in per_q}
    for k, title in (("category", "категория"), ("area", "область"), ("type", "тип")):
        lines += [f"| {title} | n | средний балл |", "|---|---|---|"] + breakdown(list(per_q.items()), k, items) + [""]
    lines.append("## Поражения и ничьи\n")
    bot = read_answers(report / "bot" / "submission.csv")
    base = read_answers(baseline_path(report, baseline_pred))
    for qid, s in sorted(per_q.items(), key=lambda x: x[1]):
        if s > 0.5:
            break
        c = cases[qid]
        lines += [f"### {qid} — {s:.2f} [{c.get('category')}]",
                  f"- раунд 1: {rounds[qid][1][1]}", f"- раунд 2: {rounds[qid][2][1]}",
                  f"- вопрос: {c['question']}", f"- бот: {bot.get(qid, '')}", f"- бейзлайн: {base.get(qid, '')}",
                  f"- эталон: {c['reference']}", ""]
    missing_pairs = len(key) // 2 - m["n"]
    if missing_pairs:
        lines.insert(2, f"⚠️ Без пары вердиктов осталось {missing_pairs} вопросов — они не учтены.\n")
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:5]))
    print(f"Отчёт: {out / 'report.md'}")
    if min_score is not None and (m["score"] is None or m["score"] < min_score):
        print(f"Score {m['score']} ниже порога {min_score}", file=sys.stderr)
        sys.exit(2)
    return m["score"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["export", "score"])
    ap.add_argument("report", help="папка прогона eval/reports/<время>")
    ap.add_argument("--parts", type=int, default=8)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--baseline-pred", help="ответы бейзлайна из кэша вместо <report>/baseline/submission.csv")
    ap.add_argument("--key", help="где хранить ключ (по умолчанию рядом с пакетами)")
    ap.add_argument("--out", help="папка пакетов/вердиктов (по умолчанию <report>/blind)")
    ap.add_argument("--min-score", type=float, help="score: код выхода 2, если Score ниже порога")
    args = ap.parse_args()
    report = Path(args.report)
    if args.command == "export":
        export(report, args.parts, args.seed, args.baseline_pred, args.key, args.out)
    else:
        score(report, args.baseline_pred, args.key, args.out, args.min_score)


if __name__ == "__main__":
    main()
