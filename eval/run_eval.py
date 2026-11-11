"""Локальный стенд оценки: прогон как на платформе + стиль + проверки + LLM-судья.

Что делает:
1. Собирает папку данных как на платформе: questions.csv (выборка и/или демо жюри)
   и knowledge-base.zip — и запускает solution.py отдельным процессом.
2. Опционально так же прогоняет учебный бейзлайн (--baseline), чтобы сравнивать с ним,
   как это делает судья платформы.
3. Считает стиль ответов против эталона: длина, вопрос в конце, markdown.
4. Проверяет обязательные/запрещённые факты (must/must_not) без LLM.
5. Если задан ключ, работает LLM-судья. С ответами бейзлайна — по методике платформы
   (docs/tech-regulations.md, раздел 8): два раунда с перестановкой, Score = 0,7·Match Rate +
   0,3·Win Rate. Без бейзлайна — абсолютная оценка 0–10 против эталона. Разбивка по
   категориям, областям и типам.

    python eval/run_eval.py                       # рабочая часть выборки (dev)
    python eval/run_eval.py --with-demo --baseline # dev + демо жюри, Score как на платформе
    python eval/run_eval.py --baseline-pred eval/reports/<время>/baseline/submission.csv  # бейзлайн из кэша
    python eval/run_eval.py --set demo            # только демо жюри
    python eval/run_eval.py --set holdout         # отложенная часть — запускать редко
    python eval/run_eval.py --filter 'trap|out-of' --limit 50
    python eval/run_eval.py --pred путь.csv       # оценить готовый файл ответов без прогона

Отчёт: eval/reports/<время>/report.md (+ answers.md, predictions.csv, details.jsonl).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "eval"))

from energybot.llm import Api, env  # noqa: E402
from validate_dataset import violates  # noqa: E402

JUDGE_PROMPT = """Ты — строгий эксперт, проверяющий ответы ИИ-консультанта МТС EnergyTool (энергетика для бизнеса).
Сравни ОТВЕТ БОТА с ЭТАЛОННЫМ ОТВЕТОМ на тот же вопрос клиента. Эталон опирается на базу знаний компании и считается верным.

Оцени по шкале 0–10:
- 9–10: по сути совпадает с эталоном: тот же вывод (да/нет/что делать), ключевые факты и оговорки есть, нет противоречий и выдуманных фактов, кратко и по-консультантски.
- 6–8: вывод верный, но упущен важный факт/оговорка, или ответ заметно длиннее/водянистее, или лишний/неуместный вопрос.
- 3–5: частично верно: вывод размыт, упущена главная мысль эталона, есть сомнительные утверждения.
- 0–2: неверный вывод, противоречие эталону, выдуманные цифры/обещания, отказ без причины, ответ не на тот вопрос.
Факты, которых нет в эталоне, допустимы только если они не противоречат ему и звучат как общие пояснения; конкретные цифры, сроки, цены, обещания сверх эталона — серьёзная ошибка.

Верни строго JSON: {"score": <0-10>, "verdict": "<одна фраза: главное отличие от эталона>"}"""

# Попарное сравнение по методике платформы (docs/tech-regulations.md, раздел 8):
# ответ команды сравнивается с бейзлайном, ориентир — эталонный ответ (golden).
PAIR_PROMPT = """Ты — судья, сравнивающий два ответа ИИ-консультанта МТС EnergyTool (энергетика для бизнеса) на один вопрос клиента.
Ориентируйся на ЭТАЛОННЫЙ ОТВЕТ: он опирается на базу знаний компании и считается верным.

Чем лучше ответ:
- совпадает с эталоном по сути: тот же вывод (да/нет/что делать), ключевые факты, цифры и оговорки;
- не содержит выдуманных фактов, цифр, обещаний и противоречий эталону;
- отвечает именно на последний вопрос клиента с учётом истории диалога;
- краток и понятен, как консультант; уместно уточняет данные клиента.

Сравни ОТВЕТ B с ОТВЕТОМ A и выбери ровно один вердикт:
- "B_much_better" — B значительно лучше A;
- "B_better" — B немного лучше A;
- "equal" — сопоставимы по качеству;
- "A_better" — B немного хуже A;
- "A_much_better" — B значительно хуже A.

Верни строго JSON: {"verdict": "<вердикт>", "reason": "<одна фраза>"}"""

VERDICT_SCORE = {"B_much_better": 1.0, "B_better": 0.75, "equal": 0.5, "A_better": 0.25, "A_much_better": 0.0}


def read_csv(path: Path, key: str = "answer") -> dict:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {r["id"].strip(): r[key] for r in csv.DictReader(f)}


def build_data_dir(items: list, kb_dir: Path, target: Path):
    target.mkdir(parents=True, exist_ok=True)
    with open(target / "questions.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["id", "question"])
        w.writerows((i["id"], i["question"]) for i in items)
    with zipfile.ZipFile(target / "knowledge-base.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(kb_dir.rglob("*.md")):
            z.write(p, p.relative_to(kb_dir).as_posix())


def run_solution(script: Path, data_dir: Path, workdir: Path, debug: bool) -> tuple:
    workdir.mkdir(parents=True, exist_ok=True)
    out = workdir / "submission.csv"
    envs = dict(os.environ, DATA_DIR=str(data_dir), OUTPUT_PATH=str(out))
    if debug:
        envs["DEBUG_JSONL"] = str(workdir / "debug.jsonl")
    t0 = time.perf_counter()
    proc = subprocess.run([sys.executable, str(script)], cwd=workdir, env=envs, capture_output=True, text=True)
    elapsed = time.perf_counter() - t0
    (workdir / "stderr.log").write_text(proc.stderr, encoding="utf-8")
    if proc.returncode != 0 or not out.is_file():
        raise RuntimeError(f"{script} завершился с кодом {proc.returncode}:\n{proc.stderr[-2000:]}")
    return read_csv(out), elapsed


def style(answers: list) -> dict:
    words = [len(a.split()) for a in answers]
    return {
        "n": len(answers),
        "слов, медиана": statistics.median(words) if words else 0,
        "слов, макс": max(words) if words else 0,
        "> 150 слов": sum(w > 150 for w in words),
        "вопрос в конце, %": round(100 * sum(a.rstrip().endswith("?") for a in answers) / max(1, len(answers))),
        "markdown/списки": sum(bool(re.search(r"\*\*|^#|\n-|^\s*\d+\.", a, re.M)) for a in answers),
    }


def run_checks(cases: list, answers: dict) -> list:
    results = []
    for c in cases:
        a = answers.get(c["id"], "")
        missing = [p for p in c.get("must", []) if not re.search(p, a, re.I)]
        forbidden = [p for p in c.get("must_not", []) if violates(p, a)]
        results.append({"id": c["id"], "category": c["category"], "ok": not missing and not forbidden,
                        "missing": missing, "forbidden": forbidden, "answer": a})
    return results


def judge_api():
    api = Api()
    api.base_url = (env("JUDGE_BASE_URL") or api.base_url).rstrip("/")
    api.llm_key = env("JUDGE_API_KEY") or api.llm_key
    api.llm_model = env("JUDGE_MODEL") or api.llm_model
    api.max_tokens = 1500  # при 300 размышление съедало лимит до JSON — раунды терялись
    return api if api.configured else None


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def judge_one(api, question, reference, answer):
    msg = f"ВОПРОС КЛИЕНТА:\n{question}\n\nЭТАЛОННЫЙ ОТВЕТ:\n{reference}\n\nОТВЕТ БОТА:\n{answer}"
    for _ in range(2):  # одна повторная попытка: иногда модель отвечает не JSON
        try:
            out = parse_json(api.chat([{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": msg}]))
        except Exception as exc:  # noqa: BLE001
            return None, f"ошибка судьи: {exc}"
        if "score" in out:
            return float(out["score"]), out.get("verdict", "")
    return None, "судья вернул ответ не в формате JSON"


def judge_round(api, question, reference, a, b):
    """Один раунд: оценка ответа B относительно A (1.0 … 0.0) или None при ошибке судьи."""
    msg = f"ВОПРОС КЛИЕНТА:\n{question}\n\nЭТАЛОННЫЙ ОТВЕТ:\n{reference}\n\nОТВЕТ A:\n{a}\n\nОТВЕТ B:\n{b}"
    for _ in range(2):
        try:
            out = parse_json(api.chat([{"role": "system", "content": PAIR_PROMPT}, {"role": "user", "content": msg}]))
        except Exception as exc:  # noqa: BLE001
            return None, f"ошибка судьи: {exc}"
        if out.get("verdict") in VERDICT_SCORE:
            return VERDICT_SCORE[out["verdict"]], out.get("reason", "")
    return None, "судья вернул ответ не в формате JSON"


def judge_vs_baseline(api, question, reference, team, baseline):
    """Два раунда с перестановкой, как на платформе. Балл команды за вопрос — 0…1 или None."""
    s1, r1 = judge_round(api, question, reference, baseline, team)  # A — baseline, B — команда
    s2, r2 = judge_round(api, question, reference, team, baseline)  # A — команда, B — baseline
    if s1 is None or s2 is None:
        return None, r1 if s1 is None else r2
    return (s1 + (1 - s2)) / 2, f"R1: {r1} | R2: {r2}"


def platform_metrics(scores: list) -> dict:
    """Match Rate, Win Rate и итоговый Score по формуле регламента (ошибки судьи исключены)."""
    valid = [s for s in scores if s is not None]
    if not valid:
        return {"n": 0, "match_rate": None, "win_rate": None, "score": None, "wins": 0, "losses": 0, "ties": 0}
    wins = sum(s > 0.5 for s in valid)
    losses = sum(s < 0.5 for s in valid)
    match_rate = sum(valid) / len(valid)
    win_rate = wins / (wins + losses) if wins + losses else 0.5
    return {"n": len(valid), "match_rate": match_rate, "win_rate": win_rate,
            "score": 0.7 * match_rate + 0.3 * win_rate, "wins": wins, "losses": losses,
            "ties": len(valid) - wins - losses}


def load_items(args) -> list:
    """Демо жюри + расширенная выборка: у каждого кейса свой эталон и проверки."""
    items = []
    if args.set in ("demo", "all"):
        reference = read_csv(Path(args.reference)) if Path(args.reference).is_file() else {}
        with open(args.questions, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                qid = r["id"].strip()
                items.append({"id": f"demo-{qid}", "question": r["question"], "reference": reference.get(qid, ""),
                              "category": "demo", "area": "demo", "type": "dialog" if "Ассистент:" in r["question"] else "single",
                              "must": [], "must_not": []})
    if args.set in ("dev", "holdout", "all") and Path(args.dataset).is_file():
        for line in Path(args.dataset).read_text(encoding="utf-8").splitlines():
            c = json.loads(line)
            if args.set == "all" or c.get("split") == args.set:
                items.append(c)
    if args.filter:
        items = [i for i in items if re.search(args.filter, f"{i['id']} {i['category']} {i.get('area', '')}")]
    if args.limit and len(items) > args.limit:
        # Равномерный срез по всему списку, а не первые N: так в быстрый прогон попадают все области.
        step = len(items) / args.limit
        items = [items[int(i * step)] for i in range(args.limit)]
    return items


def breakdown(values: list, key: str, items: dict) -> list:
    groups = {}
    for qid, v in values:
        if v is not None:
            groups.setdefault(items[qid].get(key, "?"), []).append(v)
    return [f"| {g} | {len(v)} | {statistics.mean(v):.2f} |" for g, v in sorted(groups.items())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["demo", "dev", "holdout", "all"], default="dev",
                    help="demo — 18 вопросов жюри; dev — демо не входит, рабочая часть выборки; all — всё")
    ap.add_argument("--with-demo", action="store_true", help="добавить демо к dev/holdout")
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "dataset" / "cases.jsonl"))
    ap.add_argument("--questions", default=str(ROOT / "demo_questions.csv"))
    ap.add_argument("--reference", default=str(ROOT / "demo_output.csv"))
    ap.add_argument("--filter", help="regex по id/категории/области, например 'trap|out-of'")
    ap.add_argument("--limit", type=int, help="взять N кейсов равномерно по всему набору")
    ap.add_argument("--kb", default=str(ROOT / "knowledge-base"))
    ap.add_argument("--solution", default=str(ROOT / "solution.py"))
    ap.add_argument("--baseline", action="store_true", help="прогнать и учебный бейзлайн")
    ap.add_argument("--baseline-pred", help="готовые ответы бейзлайна (CSV) вместо прогона, например "
                                            "eval/reports/<время>/baseline/submission.csv")
    ap.add_argument("--pred", help="готовый CSV с ответами вместо прогона")
    ap.add_argument("--no-judge", action="store_true")
    args = ap.parse_args()

    items_list = load_items(args)
    if args.with_demo and args.set in ("dev", "holdout"):
        demo_args = argparse.Namespace(**{**vars(args), "set": "demo", "filter": None, "limit": None})
        items_list = load_items(demo_args) + items_list
    if not items_list:
        sys.exit("Нет кейсов: проверьте --set/--filter и наличие eval/dataset/cases.jsonl (python eval/build_dataset.py)")
    items = {i["id"]: i for i in items_list}
    ids = list(items)

    report_dir = ROOT / "eval" / "reports" / time.strftime("%Y%m%d-%H%M%S")
    report_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"# Отчёт стенда {report_dir.name}\n", f"Набор: {args.set}{' + демо' if args.with_demo else ''}"
             f"{f', фильтр {args.filter}' if args.filter else ''}; кейсов: {len(ids)}\n"]

    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "data"
        build_data_dir(items_list, Path(args.kb), data_dir)
        if args.pred:
            answers, elapsed = read_csv(Path(args.pred)), None
        else:
            answers, elapsed = run_solution(Path(args.solution), data_dir, report_dir / "bot", debug=True)
        baseline = read_csv(Path(args.baseline_pred)) if args.baseline_pred else {}
        if args.baseline and not baseline:
            baseline, b_elapsed = run_solution(ROOT / "sample_submission" / "solution.py", data_dir,
                                               report_dir / "baseline", debug=False)
            lines.append(f"Бейзлайн: {len(baseline)} ответов за {b_elapsed:.0f} c\n")

    if elapsed is not None:
        lines.append(f"Бот: {len(answers)} ответов за {elapsed:.0f} c "
                     f"({elapsed / max(1, len(answers)):.1f} c на вопрос при параллельной обработке)\n")
    fallbacks = sum("в моих материалах нет, поэтому не буду гадать" in answers.get(i, "") for i in ids)
    lines.append(f"Запасных ответов (сбой LLM): {fallbacks}\n")

    # Стиль
    lines.append("## Стиль\n")
    cols = {"бот": style([answers.get(i, "") for i in ids]),
            "эталон": style([items[i]["reference"] for i in ids if items[i].get("reference")])}
    if baseline:
        cols["бейзлайн"] = style([baseline.get(i, "") for i in ids])
    keys = list(cols["бот"].keys())
    lines.append("| метрика | " + " | ".join(cols) + " |")
    lines.append("|---|" + "---|" * len(cols))
    for k in keys:
        lines.append(f"| {k} | " + " | ".join(str(c[k]) for c in cols.values()) + " |")
    lines.append("")

    # Детерминированные проверки must / must_not
    details = []
    checked = [items[i] for i in ids if items[i].get("must") or items[i].get("must_not")]
    if checked:
        res = run_checks(checked, answers)
        ok = sum(r["ok"] for r in res)
        lines.append(f"## Проверки фактов и ловушек: {ok}/{len(res)} ({100 * ok // len(res)}%)\n")
        lines.append("| категория | пройдено |")
        lines.append("|---|---|")
        by_cat = {}
        for r in res:
            by_cat.setdefault(r["category"], []).append(r["ok"])
        lines += [f"| {k} | {sum(v)}/{len(v)} |" for k, v in sorted(by_cat.items())]
        lines.append("")
        for r in res:
            if not r["ok"]:
                lines.append(f"- ❌ `{r['id']}` нет: {r['missing']} запрещено: {r['forbidden']}\n  > {r['answer']}")
        lines.append("")
        details += [{"kind": "check", **r} for r in res]

    # LLM-судья. С ответами бейзлайна — ровно методика платформы (2 раунда, Match/Win Rate, Score),
    # без них — абсолютная оценка 0–10 против эталона.
    api = None if args.no_judge else judge_api()
    judged = [i for i in ids if items[i].get("reference")]
    if api and judged:
        platform_mode = bool(baseline)
        missing = [i for i in judged if not baseline.get(i)] if platform_mode else []
        if missing:
            lines.append(f"⚠️ Нет ответов бейзлайна для {len(missing)} вопросов (например {missing[:3]}) — "
                         f"пересоберите кэш бейзлайна на этом наборе (--baseline).\n")
        with ThreadPoolExecutor(max_workers=6) as pool:
            if platform_mode:
                scores = list(pool.map(lambda i: judge_vs_baseline(api, items[i]["question"], items[i]["reference"],
                                                                   answers.get(i, ""), baseline.get(i, "")), judged))
            else:
                scores = list(pool.map(lambda i: judge_one(api, items[i]["question"], items[i]["reference"],
                                                           answers.get(i, "")), judged))
        failed = sum(s is None for s, _ in scores)
        if platform_mode:
            m = platform_metrics([s for s, _ in scores])
            lines.append(f"## LLM-судья ({api.llm_model}) по методике платформы: против бейзлайна, ориентир — эталон\n")
            if m["n"]:
                lines.append(f"**Score = {m['score']:.3f}** (0,7 × Match Rate {m['match_rate']:.3f} + "
                             f"0,3 × Win Rate {m['win_rate']:.3f}); побед {m['wins']}, ничьих {m['ties']}, "
                             f"поражений {m['losses']}, n={m['n']}\n")
            unit = "средний балл (0–1, 0,5 = как бейзлайн)"
        else:
            valid = [s for s, _ in scores if s is not None]
            lines.append(f"## LLM-судья ({api.llm_model}) против эталона, 0–10\n")
            lines.append("Ответов бейзлайна нет — это не метрика платформы. Для неё запустите с --baseline "
                         "или --baseline-pred.\n")
            if valid:
                lines.append(f"Средний балл: **{statistics.mean(valid):.2f} / 10** (n={len(valid)}), "
                             f"доля ≥8: {100 * sum(v >= 8 for v in valid) // len(valid)}%\n")
            unit = "средний балл (0–10)"
        if failed:
            lines.append(f"Сбоев судьи: {failed} — эти вопросы исключены из расчёта, как на платформе\n")
        per_question = [(i, s) for i, (s, _) in zip(judged, scores)]
        for key, title in (("category", "категория"), ("area", "область"), ("type", "тип")):
            lines.append(f"| {title} | n | {unit} |")
            lines.append("|---|---|---|")
            lines += breakdown(per_question, key, items)
            lines.append("")
        worst = sorted([(s, i, v) for i, (s, v) in zip(judged, scores) if s is not None])[:15]
        lines.append("### Худшие ответы\n")
        for s, i, v in worst:
            lines.append(f"- **{i}** ({s:.2f}): {v}\n  - вопрос: {items[i]['question']}\n  - бот: {answers.get(i, '')}"
                         + (f"\n  - бейзлайн: {baseline.get(i, '')}" if platform_mode else "")
                         + f"\n  - эталон: {items[i]['reference']}")
        lines.append("")
        for i, (s, v) in zip(judged, scores):
            details.append({"kind": "judge", "mode": "platform" if platform_mode else "absolute",
                            "id": i, "score": s, "verdict": v})
    elif not args.no_judge:
        lines.append("## LLM-судья\nПропущен: нет ключа (LLM_BASE_URL/LLM_API_KEY или JUDGE_*).\n")

    # Все ответы — отдельным файлом, чтобы отчёт оставался читаемым
    full = []
    for i in ids:
        full.append(f"**{i}** [{items[i].get('category')}] {items[i]['question']}\n\n- бот: {answers.get(i, '')}")
        if items[i].get("reference"):
            full.append(f"- эталон: {items[i]['reference']}")
        if i in baseline:
            full.append(f"- бейзлайн: {baseline[i]}")
        full.append("")
    (report_dir / "answers.md").write_text("\n".join(full), encoding="utf-8")

    with open(report_dir / "predictions.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["id", "answer"])
        w.writerows((i, answers.get(i, "")) for i in ids)
    with open(report_dir / "details.jsonl", "w", encoding="utf-8") as f:
        for d in details:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    (report_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nОтчёт: {report_dir / 'report.md'}; все ответы: {report_dir / 'answers.md'}")


if __name__ == "__main__":
    main()
