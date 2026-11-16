"""Стресс-тест по персонам (T14): сценарные многоходовые диалоги с ботом в режиме chat и метрики.

Пять аудиторий кейса (МСБ, энергетик, СНТ/УК/ТСЖ, сетевая компания, менеджер МТС) × сценарии из
eval/personas/scenarios.jsonl. Реплики клиента заранее записаны (детерминированный скрипт без второй модели):
прогон дешевле и воспроизводим. Бот — то же ядро, что у веб-чата (energybot.Consultant, режим chat, стиль
jury по умолчанию — как в scripts/core_api.py). solution.py и режим автопроверки не затрагиваются.

    python eval/personas.py                   # проверка сценариев и оценка цены, без вызовов модели
    python eval/personas.py --mock            # прогон на заглушке API (tests/mock_api.py) — бесплатно
    set -a; source .env; set +a               # ключи сам скрипт из .env не читает — только явно
    python eval/personas.py --real            # настоящий прогон: платный, только с разрешения владельца ядра
    python eval/personas.py --real --publish  # + копия отчёта для страницы /lab стенда
    python eval/personas.py --real --persona snt --limit 1

Отчёт: eval/reports/personas/<время>.json (в .gitignore). --publish кладёт копию в
web/src/app/lab/personas-latest.json — её показывает /lab. В отчёте нет текстов базы: только реплики
диалога, метрики и id разделов. Отчёт с заглушки не публикуется.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.guard import unknown_numbers  # noqa: E402

SCENARIOS = ROOT / "eval" / "personas" / "scenarios.jsonl"
REPORTS = ROOT / "eval" / "reports" / "personas"
PUBLISHED = ROOT / "web" / "src" / "app" / "lab" / "personas-latest.json"
SCHEMA = "personas/v1"

# Порядок — как в кейсе (стр. 5 МТС_кейс.pdf).
PERSONAS = {
    "msb": "МСБ",
    "engineer": "Энергетик, главный инженер",
    "snt": "СНТ, УК, ТСЖ",
    "grid": "Сетевая компания",
    "mts_manager": "Региональный менеджер МТС",
}

# Предложение заявки: специалист, менеджер, заявка, контакты, расчёт по объекту, обратный звонок.
LEAD = re.compile(
    r"специалист|менеджер|заявк|контакт|обратн\w* звон|перезвон|свяж[еу]тся|"
    r"передать (?:ваш\w* )?(?:запрос|вопрос|задач)|(?:оценк|расч[её]т)\w* по (?:\w+ ){0,2}объект",
    re.I,
)
PASSPORT_NOTE = "появится после T2: паспорта клиента в ядре ещё нет"
HEURISTICS = {
    "clean_numbers": "в ответе нет чисел, которых нет ни в базе знаний целиком, ни в репликах клиента "
                     "(energybot.guard.unknown_numbers; 1 и 2 не проверяются)",
    "question": "в ответе есть знак «?» — считаем, что бот задал уточняющий вопрос",
    "lead_offer": "в ответе есть слова о специалисте, менеджере, заявке, контактах, обратном звонке или "
                  "расчёте по объекту (регулярное выражение LEAD)",
    "lead_timing": "context_turn сценария — реплика клиента, после которой известны объект и задача. Первое "
                   "предложение заявки в ответе на эту реплику или позже — вовремя, раньше — рано, ни разу — "
                   "упущено. Для менеджера МТС заявка не ожидается: её отсутствие — норма, предложение — лишнее",
    "passport_fill": PASSPORT_NOTE,
}
LEAD_OK = ("timely", "none_ok")


# ---------- сценарии ----------
def load_scenarios(path: Path = SCENARIOS) -> list:
    items = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    errors = validate_scenarios(items)
    if errors:
        raise ValueError(f"{path}: " + "; ".join(errors))
    return items


def validate_scenarios(items: list) -> list:
    errors, seen = [], set()
    for s in items:
        sid = s.get("id", "?")
        if sid in seen:
            errors.append(f"{sid}: повтор id")
        seen.add(sid)
        if s.get("persona") not in PERSONAS:
            errors.append(f"{sid}: неизвестная персона {s.get('persona')!r}")
        replies = [s.get("start", "")] + list(s.get("followups") or [])
        if not all(isinstance(r, str) and r.strip() for r in replies):
            errors.append(f"{sid}: пустая реплика клиента")
        if not (isinstance(s.get("context_turn"), int) and 1 <= s["context_turn"] <= len(replies)):
            errors.append(f"{sid}: context_turn вне 1..{len(replies)}")
        if not isinstance(s.get("lead_expected"), bool):
            errors.append(f"{sid}: lead_expected — true или false")
    return errors


def client_replies(s: dict) -> list:
    return [s["start"]] + list(s["followups"])


# ---------- метрики ----------
def asks_question(text: str) -> bool:
    return "?" in text


def offers_lead(text: str) -> bool:
    return bool(LEAD.search(text))


def lead_status(offers: list, context_turn: int, expected: bool) -> dict:
    """offers — по ответам бота, был ли в нём призыв к заявке; номера реплик с 1."""
    first = next((i + 1 for i, o in enumerate(offers) if o), None)
    if not expected:
        status = "extra" if first else "none_ok"
    elif first is None:
        status = "missing"
    else:
        status = "early" if first < context_turn else "timely"
    return {"status": status, "first_offer_turn": first, "context_turn": context_turn, "expected": expected}


def rate(part: int, total: int):
    return round(part / total, 3) if total else None


def summarize(dialogs: list) -> dict:
    turns = [t for d in dialogs for t in d["turns"]]
    leads = [d["lead"]["status"] for d in dialogs]
    firsts = [d["turns"][0] for d in dialogs if d["turns"]]
    return {
        "scenarios": len(dialogs),
        "turns": len(turns),
        "clean_numbers_rate": rate(sum(not t["unknown_numbers"] for t in turns), len(turns)),
        "question_rate": rate(sum(t["asked_question"] for t in turns), len(turns)),
        "first_reply_question_rate": rate(sum(t["asked_question"] for t in firsts), len(firsts)),
        "lead": {k: leads.count(k) for k in ("timely", "early", "missing", "none_ok", "extra")},
        "lead_ok_rate": rate(sum(s in LEAD_OK for s in leads), len(leads)),
        "fallback_rate": rate(sum(t["fallback"] for t in turns), len(turns)),
        "guard_fired_rate": rate(sum(bool(t["guard"]) for t in turns), len(turns)),
        "llm_calls": {k: sum(t["llm_calls"][k] for t in turns) for k in ("chat", "embed", "rerank")},
        "passport_fill": None,
        "passport_fill_note": PASSPORT_NOTE,
    }


# ---------- цена прогона ----------
def estimate(scenarios: list) -> dict:
    """Сколько вызовов модели займёт прогон. Нижняя граница — одна генерация на реплику; проверка чисел
    перезапрашивает ответ, только если в нём число не из материалов."""
    turns = sum(len(client_replies(s)) for s in scenarios)
    flags = [name for name, on in (
        ("EB_EVIDENCE=1", os.getenv("EB_EVIDENCE") == "1"), ("EB_CHECK=1", os.getenv("EB_CHECK") == "1"),
        ("EB_TWO_STAGE=1", os.getenv("EB_TWO_STAGE") == "1"), ("EB_REFINE=1", os.getenv("EB_REFINE") == "1"),
    ) if on]
    per_turn = 1 + len(flags)
    return {
        "personas": len({s["persona"] for s in scenarios}),
        "scenarios": len(scenarios),
        "client_turns": turns,
        "chat_calls_min": turns * per_turn,
        "chat_calls_max": turns * (per_turn + 1),
        "embed_calls": turns,
        "rerank_calls": turns,
        "extra_flags": flags,
    }


def print_estimate(est: dict) -> None:
    extra = f" (с учётом {', '.join(est['extra_flags'])})" if est["extra_flags"] else ""
    print(f"Персон: {est['personas']}, сценариев: {est['scenarios']}, реплик клиента: {est['client_turns']}.")
    print(f"Вызовов модели на настоящем прогоне: чат — {est['chat_calls_min']}–{est['chat_calls_max']}{extra} "
          f"(генерация на каждую реплику + перезапрос, если проверка нашла число не из материалов); "
          f"эмбеддинги запроса — до {est['embed_calls']}, реранкер — до {est['rerank_calls']} "
          "(если включены); эмбеддинги базы — один раз при старте, если нет кэша index/.")


def print_real_hint() -> None:
    print("\nНастоящий прогон — платный, только с разрешения владельца ядра:")
    print("  set -a; source .env; set +a   # LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, EMB_MODEL, RERANKER_MODEL "
          "(см. .env.example)")
    print("  .venv/bin/python eval/personas.py --real --publish")


# ---------- прогон ----------
class Counter:
    """Считает вызовы модели за реплику: обёртки над методами Api, как запись вызовов в scripts/core_api.py."""

    def __init__(self, api):
        self.calls = {"chat": 0, "embed": 0, "rerank": 0}
        for name in self.calls:
            setattr(api, name, self._wrap(name, getattr(api, name)))

    def _wrap(self, name, fn):
        def counted(*args, **kwargs):
            self.calls[name] += 1
            return fn(*args, **kwargs)
        return counted

    def take(self) -> dict:
        taken, self.calls = self.calls, dict.fromkeys(self.calls, 0)
        return taken


def chunk_ids(bot, sources: list) -> list:
    """Источники ответа — только id раздела и документ, без текста базы."""
    by_path = {(c.doc, c.path): c.id for c in bot.kb.chunks}
    first = {}
    for c in bot.kb.chunks:
        first.setdefault(c.doc, c.id)
    out = []
    for doc, path, _ in sources:
        whole = path == "весь документ"
        out.append({"doc": doc, "chunk_id": first.get(doc) if whole else by_path.get((doc, path)), "whole": whole})
    return out


def run_dialog(bot, counter: Counter, scenario: dict, kb_text: str) -> dict:
    from energybot.pipeline import FALLBACK

    turns, rows, said = [], [], []
    for n, reply in enumerate(client_replies(scenario), 1):
        turns.append({"role": "user", "content": reply})
        said.append(reply)
        MOCK_STATE["turn"] = n
        counter.take()
        t0 = time.perf_counter()
        try:
            answer = bot.answer(turns, mode="chat")
            text, error, guard, sources = answer.text, answer.error, answer.guard, answer.sources
        except Exception as exc:  # noqa: BLE001 — прогон не должен падать на одном ответе
            text, error, guard, sources = FALLBACK, f"{type(exc).__name__}: {exc}", {}, []
        ms = round((time.perf_counter() - t0) * 1000)
        turns.append({"role": "assistant", "content": text})
        rows.append({
            "n": n,
            "client": reply,
            "bot": text,
            "asked_question": asks_question(text),
            "lead_offer": offers_lead(text),
            # Строже проверки ядра: допустимы только числа базы и реплик клиента, не прошлых ответов бота.
            "unknown_numbers": unknown_numbers(text, kb_text, "\n".join(said)),
            "guard": {k: v for k, v in guard.items() if k in ("unknown_numbers", "too_long", "repaired",
                                                               "stripped", "dropped", "refined")},
            "fallback": text == FALLBACK or bool(error),
            "error": error,
            "sources": chunk_ids(bot, sources),
            "llm_calls": counter.take(),
            "ms": ms,
        })
        print(f"  {scenario['id']} · реплика {n}: {ms} мс, «?» {rows[-1]['asked_question']}, "
              f"заявка {rows[-1]['lead_offer']}, числа вне базы {rows[-1]['unknown_numbers'] or '—'}", file=sys.stderr)
    lead = lead_status([r["lead_offer"] for r in rows], scenario["context_turn"], scenario["lead_expected"])
    return {
        "id": scenario["id"], "persona": scenario["persona"], "title": scenario.get("title", scenario["id"]),
        "lead": lead, "passport_fill": None, "turns": rows,
    }


MOCK_TURN_1 = ("Подскажу по вашей ситуации. Уточните, пожалуйста: какой у вас объект и какая задача — учёт, "
               "снижение платежа или поиск потерь?")
MOCK_TURN_2 = "Здесь подойдёт облачная платформа учёта: показания собираются дистанционно. Какие у вас приборы?"
MOCK_TURN_3 = ("Точную картину покажет бесплатная предварительная оценка по данным объекта. Могу передать ваш "
               "запрос специалисту — оставите контакты?")

# Номер текущей реплики клиента для заглушки: ядро v28 режет диалог по сегментам темы (current_segment), и по
# сообщениям модели номер реплики не восстановить. run_dialog проставляет его перед каждым ответом.
MOCK_STATE = {"turn": 1}


def mock_responder(messages: list) -> str:
    """Детерминированный «бот» заглушки: вопрос на первой реплике, продукт со «случайным» числом на второй
    (самопроверка ядра v28 уберёт число), предложение специалиста дальше. Самопроверка (сообщение
    «[Служебная …») отвечает на ту же реплику, но без выдуманного числа."""
    if str(messages[0]["content"]).startswith("Определи тип последнего вопроса"):
        return "process"
    check = str(messages[-1]["content"]).startswith("[Служебная")
    turn = MOCK_STATE["turn"]
    if turn == 1:
        return MOCK_TURN_1
    if turn == 2:
        return MOCK_TURN_2 if check else MOCK_TURN_2.replace("учёта:", "учёта, подключение займёт 987 дней:", 1)
    return MOCK_TURN_3


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def run(scenarios: list, mock: bool) -> dict:
    # Как стенд: режим chat.
    from energybot.llm import Api, env
    from energybot.pipeline import Consultant

    kb_path = Path(env("EB_KB_PATH", str(ROOT / "knowledge-base")))
    if mock:
        bot = Consultant(kb_path, index_dir=None, api=Api())  # векторы заглушки в index/ не пишем
    else:
        bot = Consultant(kb_path, index_dir=ROOT / "index", api=Api())
    counter = Counter(bot.api)
    counter.take()  # эмбеддинги базы при старте — не реплики
    t0 = time.perf_counter()
    kb_text = "\n".join(c.render() for c in bot.kb.chunks)
    dialogs = [run_dialog(bot, counter, s, kb_text) for s in scenarios]
    personas = []
    for key, name in PERSONAS.items():
        own = [d for d in dialogs if d["persona"] == key]
        if own:
            personas.append({"persona": key, "name": name, **summarize(own)})
    return {
        "schema": SCHEMA,
        "mock": mock,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "commit": git_commit(),
        "model": "заглушка tests/mock_api.py" if mock else env("LLM_MODEL", ""),
        "config": {"mode": "chat", "arch": bot.arch, "top_k": bot.top_k,
                   "n_candidates": bot.n_candidates, "expand_docs": bot.expand_docs,
                   "context_chars": bot.context_chars, "dense": bot.dense, "reranker": bool(bot.api.configured and bot.api.can_rerank),
                   "kb_fingerprint": bot.kb.fingerprint},
        "scenarios_file": SCENARIOS.relative_to(ROOT).as_posix(),
        "duration_sec": round(time.perf_counter() - t0, 1),
        "heuristics": HEURISTICS,
        "estimate": estimate(scenarios),
        "totals": summarize(dialogs),
        "personas": personas,
        "dialogs": dialogs,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    how = p.add_mutually_exclusive_group()
    how.add_argument("--mock", action="store_true", help="прогон на заглушке API (бесплатно)")
    how.add_argument("--real", action="store_true", help="настоящий прогон (платно, только с разрешения владельца ядра)")
    p.add_argument("--scenarios", type=Path, default=SCENARIOS)
    p.add_argument("--persona", action="append", choices=list(PERSONAS), help="только эти персоны (можно повторять)")
    p.add_argument("--limit", type=int, default=0, help="не больше N сценариев на персону")
    p.add_argument("--out", type=Path, help="куда записать отчёт (по умолчанию eval/reports/personas/<время>.json)")
    p.add_argument("--publish", action="store_true", help=f"копия отчёта в {PUBLISHED.relative_to(ROOT)} (только --real)")
    args = p.parse_args(argv)

    scenarios = load_scenarios(args.scenarios)
    if args.persona:
        scenarios = [s for s in scenarios if s["persona"] in args.persona]
    if args.limit:
        kept, per = [], {}
        for s in scenarios:
            per[s["persona"]] = per.get(s["persona"], 0) + 1
            if per[s["persona"]] <= args.limit:
                kept.append(s)
        scenarios = kept
    if args.publish and not args.real:
        print("--publish только для настоящего прогона: отчёт заглушки не выдаётся за результат модели.",
              file=sys.stderr)
        return 2
    est = estimate(scenarios)

    if not (args.mock or args.real):
        print("Сценарии в порядке, модель не вызывалась.")
        print_estimate(est)
        print("\nБесплатная проверка на заглушке: python eval/personas.py --mock")
        print_real_hint()
        return 0

    if args.real:
        from energybot.llm import Api
        if not Api().configured:
            print("Нет LLM_BASE_URL / LLM_API_KEY в окружении. Скрипт не читает .env сам — задайте переменные явно.",
                  file=sys.stderr)
            print_real_hint()
            return 2
        report = run(scenarios, mock=False)
    else:
        sys.path.insert(0, str(ROOT / "tests"))
        from mock_api import MockApi

        # Заглушка не должна утечь к настоящим адресам: всё, что ядро берёт из окружения для API, — на неё.
        for key in ("OPENAI_BASE_URL", "OPENAI_API_KEY", "BASE_URL", "EB_EMBEDDER_BASE_URL", "EMBEDDER_API_KEY",
                    "EB_RERANKER_BASE_URL", "RERANKER_API_KEY"):
            os.environ.pop(key, None)
        with MockApi(reject_template_kwargs=False, responder=mock_responder) as mock:
            os.environ.update(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key")
            report = run(scenarios, mock=True)

    out = args.out or REPORTS / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}{'-mock' if args.mock else ''}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, ensure_ascii=False, indent=1) + "\n"
    out.write_text(text, encoding="utf-8")
    print(f"Отчёт: {out}")
    if args.publish:
        PUBLISHED.write_text(text, encoding="utf-8")
        print(f"Опубликован для /lab: {PUBLISHED.relative_to(ROOT)} — закоммитьте его.")

    t = report["totals"]
    print(f"\n{'Персона':<28} сцен. репл.  без чисел  «?»   заявка ок  отказы")
    for row in report["personas"] + [{"name": "Итого", **t}]:
        print(f"{row['name']:<28} {row['scenarios']:>5} {row['turns']:>5}  {pct(row['clean_numbers_rate']):>9}  "
              f"{pct(row['question_rate']):>5}  {pct(row['lead_ok_rate']):>9}  {pct(row['fallback_rate']):>6}")
    print("Заполнение паспорта: —", PASSPORT_NOTE)
    calls = t["llm_calls"]
    print(f"Вызовов модели за прогон{' (заглушка)' if args.mock else ''}: чат — {calls['chat']}, "
          f"эмбеддинги — {calls['embed']}, реранкер — {calls['rerank']}.")
    if args.mock:
        print("\nЭто прогон на заглушке: ответы не модели, метрики проверяют только работу стенда.")
        print_estimate(estimate(load_scenarios(args.scenarios)))
        print_real_hint()
    return 0


def pct(value) -> str:
    return "—" if value is None else f"{round(value * 100)}%"


if __name__ == "__main__":
    sys.exit(main())
