"""Слепой судья Codex локально — то же, что задание «Codex — слепой судья» в release-gate.yml.

Одна команда: ответы бота → слепые пакеты → Codex судит каждый пакет → Score по методике платформы.
Бейзлайн берётся из кэша eval/baseline/answers.csv. Ключ «где наш ответ» лежит отдельно от пакетов,
Codex видит только один пакет за раз.

Нужно: ключ генерации в .env (как для run_eval.py) и вход в Codex (`codex login` — своя подписка ChatGPT
или CODEX_API_KEY). Подробности и запуск через CI на подписке владельца — docs/ci.md.

    python eval/codex_judge.py --set demo --packets 3                 # 18 демо-вопросов, несколько минут
    python eval/codex_judge.py --set all                              # 518 вопросов, как в CI
    python eval/codex_judge.py --report eval/reports/<время>          # оценить уже готовые ответы
    python eval/codex_judge.py --set dev --limit 40 --effort high     # быстрее и дешевле
    python eval/codex_judge.py --set demo --tier ""                   # без режима Fast (по умолчанию Fast)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

import blind_judge  # noqa: E402

BASELINE = ROOT / "eval" / "baseline" / "answers.csv"
PROMPT = ROOT / ".github" / "codex" / "judge-prompt.md"
VERDICTS = {"B_much_better", "B_better", "equal", "A_better", "A_much_better"}


def generate(args) -> Path:
    """Ответы бота через run_eval.py; возвращает папку прогона."""
    before = set((ROOT / "eval" / "reports").glob("*"))
    cmd = [sys.executable, str(ROOT / "eval" / "run_eval.py"), "--set", args.set,
           "--baseline-pred", str(BASELINE), "--no-judge"]
    if args.limit:
        cmd += ["--limit", str(args.limit)]
    if args.filter:
        cmd += ["--filter", args.filter]
    print(f"→ ответы бота: {' '.join(cmd[1:])}", flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    created = sorted(set((ROOT / "eval" / "reports").glob("*")) - before)
    if not created:
        sys.exit("run_eval.py не создал папку отчёта")
    return created[-1]


def packet_ok(packet: Path, verdicts: Path) -> str:
    pids = set(re.findall(r"^## pid (\w+)", packet.read_text(encoding="utf-8"), re.M))
    if not verdicts.is_file():
        return "файл вердиктов не создан"
    try:
        rows = [json.loads(x) for x in verdicts.read_text(encoding="utf-8").splitlines() if x.strip()]
    except json.JSONDecodeError as exc:
        return f"битый JSON: {exc}"
    got = {r.get("pid") for r in rows if r.get("verdict") in VERDICTS}
    return "" if got == pids and len(rows) == len(pids) else f"вердиктов {len(got)} из {len(pids)}"


def judge(packets_dir: Path, args) -> int:
    if not shutil.which("codex"):
        sys.exit("Codex CLI не найден: npm install -g @openai/codex, затем codex login")
    env = dict(os.environ)
    if args.codex_home:
        env["CODEX_HOME"] = str(Path(args.codex_home).expanduser())
    template = PROMPT.read_text(encoding="utf-8")
    packets = sorted(packets_dir.glob("packet-*.md"))
    done = 0
    for packet in packets:
        n = packet.stem.split("-")[1]
        target = packets_dir / f"verdicts-{n}.jsonl"
        if target.is_file() and not packet_ok(packet, target):
            print(f"  пакет {n}: уже оценён", flush=True)
            done += 1
            continue
        prompt = template.replace("{{PACKET}}", packet.name).replace("{{VERDICTS}}", target.name)
        for attempt in (1, 2):
            with tempfile.TemporaryDirectory() as work:  # в папке судьи — только его пакет
                work = Path(work)
                shutil.copy(packet, work / packet.name)
                t0 = time.perf_counter()
                proc = subprocess.run(
                    ["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", str(work),
                     "--model", args.model, "-c", f'model_reasoning_effort="{args.effort}"',
                     *(["-c", f'service_tier="{args.tier}"'] if args.tier else []), prompt],
                    env=env, capture_output=True, text=True)
                problem = packet_ok(work / packet.name, work / target.name)
                if not problem:
                    shutil.copy(work / target.name, target)
                    print(f"  пакет {n}: готово за {time.perf_counter() - t0:.0f} c", flush=True)
                    done += 1
                    break
                tail = (proc.stderr or "").strip().splitlines()[-1:] or [""]
                print(f"  пакет {n}, попытка {attempt}: {problem}; codex: {tail[0][:200]}", flush=True)
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", choices=["demo", "dev", "holdout", "all"], default="demo")
    ap.add_argument("--limit", type=int, help="взять N кейсов равномерно по набору")
    ap.add_argument("--filter", help="regex по id/категории/области")
    ap.add_argument("--report", help="готовая папка прогона run_eval.py — ответы бота не генерировать")
    ap.add_argument("--packets", type=int, default=12)
    ap.add_argument("--model", default=os.getenv("CODEX_MODEL", "gpt-6.1-sol"))
    ap.add_argument("--effort", default=os.getenv("CODEX_REASONING_EFFORT", "xhigh"),
                    choices=["low", "medium", "high", "xhigh", "max", "ultra"])
    ap.add_argument("--tier", default=os.getenv("CODEX_SERVICE_TIER", "priority"),
                    help='"priority" — режим Fast (в 2 раза быстрее, больше расход лимитов); "" — обычный')
    ap.add_argument("--codex-home", help="папка входа Codex (по умолчанию ~/.codex)")
    ap.add_argument("--min-score", type=float, help="код выхода 2, если Score ниже порога")
    args = ap.parse_args()

    report = Path(args.report) if args.report else generate(args)
    packets_dir, key = report / "blind-codex", report / "private" / "key.json"
    if not key.is_file():
        blind_judge.export(report, args.packets, 2026, str(BASELINE), str(key), str(packets_dir))
    mode = "Fast" if args.tier == "priority" else (args.tier or "обычный")
    print(f"→ судья: {args.model}, усилие {args.effort}, режим {mode}; пакеты: {packets_dir}", flush=True)
    done = judge(packets_dir, args)
    total = len(list(packets_dir.glob("packet-*.md")))
    if done < total:
        print(f"⚠️ оценено пакетов {done} из {total} — Score посчитан по оценённым; "
              f"повторный запуск с --report {report} доделает остальные", flush=True)
    blind_judge.score(report, str(BASELINE), str(key), str(packets_dir), args.min_score)


if __name__ == "__main__":
    main()
