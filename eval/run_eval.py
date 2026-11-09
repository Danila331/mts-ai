"""Локальный стенд оценки: прогон как на платформе + стиль + проверки + LLM-судья.

Что делает:
1. Собирает папку данных как на платформе: questions.csv (демо + проверочные вопросы)
   и knowledge-base.zip — и запускает solution.py отдельным процессом.
2. Опционально так же прогоняет учебный бейзлайн (--baseline), чтобы сравнивать с ним,
   как это делает судья платформы.
3. Считает стиль ответов против эталона: длина, вопрос в конце, markdown.
4. Проверяет обязательные/запрещённые факты из eval/checks.json (без LLM).
5. Если задан ключ, LLM-судья оценивает демо-ответы против эталона (0–10)
   и попарно против бейзлайна.

    python eval/run_eval.py                 # бот + стиль + проверки (+ судья, если есть ключ)
    python eval/run_eval.py --baseline      # плюс бейзлайн для сравнения
    python eval/run_eval.py --only-demo     # без проверочных вопросов
    python eval/run_eval.py --pred путь.csv # оценить готовый файл ответов без прогона

Отчёт: eval/reports/<время>/report.md (+ predictions.csv, details.jsonl).
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

from energybot.llm import Api, env  # noqa: E402

JUDGE_PROMPT = """Ты — строгий эксперт, проверяющий ответы ИИ-консультанта МТС EnergyTool (энергетика для бизнеса).
Сравни ОТВЕТ БОТА с ЭТАЛОННЫМ ОТВЕТОМ на тот же вопрос клиента. Эталон опирается на базу знаний компании и считается верным.

Оцени по шкале 0–10:
- 9–10: по сути совпадает с эталоном: тот же вывод (да/нет/что делать), ключевые факты и оговорки есть, нет противоречий и выдуманных фактов, кратко и по-консультантски.
- 6–8: вывод верный, но упущен важный факт/оговорка, или ответ заметно длиннее/водянистее, или лишний/неуместный вопрос.
- 3–5: частично верно: вывод размыт, упущена главная мысль эталона, есть сомнительные утверждения.
- 0–2: неверный вывод, противоречие эталону, выдуманные цифры/обещания, отказ без причины, ответ не на тот вопрос.
Факты, которых нет в эталоне, допустимы только если они не противоречат ему и звучат как общие пояснения; конкретные цифры, сроки, цены, обещания сверх эталона — серьёзная ошибка.

Верни строго JSON: {"score": <0-10>, "verdict": "<одна фраза: главное отличие от эталона>"}"""

PAIR_PROMPT = """Ты — эксперт, сравнивающий два ответа ИИ-консультанта МТС EnergyTool с эталоном.
Какой ответ ближе к эталону по сути (вывод, факты, оговорки), без выдумок и в стиле краткого консультанта?
Верни строго JSON: {"winner": "A" | "B" | "tie", "reason": "<одна фраза>"}"""


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
        forbidden = [p for p in c.get("must_not", []) if re.search(p, a, re.I | re.M)]
        results.append({"id": c["id"], "category": c["category"], "ok": not missing and not forbidden,
                        "missing": missing, "forbidden": forbidden, "answer": a})
    return results


def judge_api():
    api = Api()
    api.base_url = (env("JUDGE_BASE_URL") or api.base_url).rstrip("/")
    api.llm_key = env("JUDGE_API_KEY") or api.llm_key
    api.llm_model = env("JUDGE_MODEL") or api.llm_model
    api.max_tokens = 300
    return api if api.configured else None


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def judge_one(api, question, reference, answer):
    msg = f"ВОПРОС КЛИЕНТА:\n{question}\n\nЭТАЛОННЫЙ ОТВЕТ:\n{reference}\n\nОТВЕТ БОТА:\n{answer}"
    try:
        out = parse_json(api.chat([{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": msg}]))
        if "score" not in out:
            return None, "судья вернул ответ не в формате JSON"
        return float(out["score"]), out.get("verdict", "")
    except Exception as exc:  # noqa: BLE001
        return None, f"ошибка судьи: {exc}"


def judge_pair(api, question, reference, a, b):
    msg = f"ВОПРОС:\n{question}\n\nЭТАЛОН:\n{reference}\n\nОТВЕТ A:\n{a}\n\nОТВЕТ B:\n{b}"
    try:
        out = parse_json(api.chat([{"role": "system", "content": PAIR_PROMPT}, {"role": "user", "content": msg}]))
        if out.get("winner") not in ("A", "B", "tie"):
            return None, "судья вернул ответ не в формате JSON"
        return out["winner"], out.get("reason", "")
    except Exception as exc:  # noqa: BLE001
        return None, f"ошибка судьи: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", default=str(ROOT / "demo_questions.csv"))
    ap.add_argument("--reference", default=str(ROOT / "demo_output.csv"))
    ap.add_argument("--checks", default=str(ROOT / "eval" / "checks.json"))
    ap.add_argument("--kb", default=str(ROOT / "knowledge-base"))
    ap.add_argument("--solution", default=str(ROOT / "solution.py"))
    ap.add_argument("--baseline", action="store_true", help="прогнать и учебный бейзлайн")
    ap.add_argument("--pred", help="готовый CSV с ответами вместо прогона")
    ap.add_argument("--only-demo", action="store_true")
    ap.add_argument("--no-judge", action="store_true")
    args = ap.parse_args()

    with open(args.questions, encoding="utf-8-sig", newline="") as f:
        demo = [{"id": r["id"].strip(), "question": r["question"]} for r in csv.DictReader(f)]
    reference = read_csv(Path(args.reference)) if Path(args.reference).is_file() else {}
    cases = [] if args.only_demo else json.loads(Path(args.checks).read_text(encoding="utf-8"))["cases"]
    items = demo + [{"id": c["id"], "question": c["question"]} for c in cases]
    questions = {i["id"]: i["question"] for i in items}

    report_dir = ROOT / "eval" / "reports" / time.strftime("%Y%m%d-%H%M%S")
    report_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"# Отчёт стенда {report_dir.name}\n"]

    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "data"
        build_data_dir(items, Path(args.kb), data_dir)
        if args.pred:
            answers, elapsed = read_csv(Path(args.pred)), None
        else:
            answers, elapsed = run_solution(Path(args.solution), data_dir, report_dir / "bot", debug=True)
        baseline = {}
        if args.baseline:
            baseline, b_elapsed = run_solution(ROOT / "sample_submission" / "solution.py", data_dir,
                                               report_dir / "baseline", debug=False)
            lines.append(f"Бейзлайн: {len(baseline)} ответов за {b_elapsed:.0f} c\n")

    if elapsed is not None:
        lines.append(f"Бот: {len(answers)} ответов за {elapsed:.0f} c "
                     f"({elapsed / max(1, len(answers)):.1f} c на вопрос при параллельной обработке)\n")
    fallbacks = sum("в моих материалах нет, поэтому не буду гадать" in a for a in answers.values())
    lines.append(f"Запасных ответов (сбой LLM): {fallbacks}\n")

    # Стиль
    demo_ids = [i["id"] for i in demo]
    lines.append("## Стиль (демо-вопросы)\n")
    cols = {"бот": style([answers.get(i, "") for i in demo_ids])}
    if reference:
        cols["эталон"] = style([reference[i] for i in demo_ids if i in reference])
    if baseline:
        cols["бейзлайн"] = style([baseline.get(i, "") for i in demo_ids])
    keys = list(next(iter(cols.values())).keys())
    lines.append("| метрика | " + " | ".join(cols) + " |")
    lines.append("|---|" + "---|" * len(cols))
    for k in keys:
        lines.append(f"| {k} | " + " | ".join(str(c[k]) for c in cols.values()) + " |")
    lines.append("")

    # Проверки фактов
    details = []
    if cases:
        res = run_checks(cases, answers)
        ok = sum(r["ok"] for r in res)
        lines.append(f"## Проверки фактов и ловушек: {ok}/{len(res)}\n")
        by_cat = {}
        for r in res:
            by_cat.setdefault(r["category"], []).append(r["ok"])
        lines.append(", ".join(f"{k}: {sum(v)}/{len(v)}" for k, v in sorted(by_cat.items())) + "\n")
        for r in res:
            if not r["ok"]:
                lines.append(f"- ❌ `{r['id']}` нет: {r['missing']} запрещено: {r['forbidden']}\n  > {r['answer']}")
        lines.append("")
        details += [{"type": "check", **r} for r in res]

    # LLM-судья
    api = None if args.no_judge else judge_api()
    if api and reference:
        lines.append(f"## LLM-судья ({api.llm_model}) против эталона\n")
        with ThreadPoolExecutor(max_workers=4) as pool:
            scores = list(pool.map(lambda i: judge_one(api, questions[i], reference[i], answers.get(i, "")),
                                   [i for i in demo_ids if i in reference]))
            pairs = []
            if baseline:
                pairs = list(pool.map(lambda i: judge_pair(api, questions[i], reference[i], answers.get(i, ""),
                                                           baseline.get(i, "")),
                                      [i for i in demo_ids if i in reference]))
        valid = [s for s, _ in scores if s is not None]
        if len(valid) < len(scores):
            lines.append(f"Сбоев судьи: {len(scores) - len(valid)} — эти вопросы не учтены в среднем\n")
        if valid:
            lines.append(f"Средний балл: **{statistics.mean(valid):.2f} / 10** (n={len(valid)})\n")
        if pairs:
            wins = sum(w == "A" for w, _ in pairs)
            ties = sum(w == "tie" for w, _ in pairs)
            losses = sum(w == "B" for w, _ in pairs)
            failed = sum(w is None for w, _ in pairs)
            lines.append(f"Против бейзлайна: побед {wins}, ничьих {ties}, поражений {losses}"
                         f"{f', сбоев судьи {failed}' if failed else ''}\n")
        lines.append("| id | балл | вердикт |")
        lines.append("|---|---|---|")
        for i, (s, v) in zip([i for i in demo_ids if i in reference], scores):
            lines.append(f"| {i} | {s} | {v} |")
            details.append({"type": "judge", "id": i, "score": s, "verdict": v, "answer": answers.get(i, "")})
        lines.append("")
    elif not args.no_judge:
        lines.append("## LLM-судья\nПропущен: нет ключа (LLM_BASE_URL/LLM_API_KEY или JUDGE_*).\n")

    # Все ответы
    lines.append("## Ответы\n")
    for i in demo_ids + [c["id"] for c in cases]:
        lines.append(f"**{i}.** {questions[i]}\n\n- бот: {answers.get(i, '')}")
        if i in reference:
            lines.append(f"- эталон: {reference[i]}")
        if i in baseline:
            lines.append(f"- бейзлайн: {baseline[i]}")
        lines.append("")

    with open(report_dir / "predictions.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(["id", "answer"])
        w.writerows((i, answers.get(i, "")) for i in questions)
    with open(report_dir / "details.jsonl", "w", encoding="utf-8") as f:
        for d in details:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    (report_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[: lines.index("## Ответы\n")]))
    print(f"\nПолный отчёт: {report_dir / 'report.md'}")


if __name__ == "__main__":
    main()
