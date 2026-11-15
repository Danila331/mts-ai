"""Детерминированная сверка сабмита с техническим регламентом (docs/tech-regulations.md).

Собирает dist/submission.zip и проверяет то, из-за чего решение может не заработать
на лидерборде: состав архива, зависимости из набора жюри, импорты, запуск в чистом
окружении только с requirements.txt из архива и формат submission.csv.

    python scripts/check_submission.py [--final] [--zip PATH] [--report check.md]

Код выхода 1, если хоть одна проверка не прошла. Отчёт — markdown (для CI).
"""

from __future__ import annotations

import argparse
import ast
import csv
import os
import re
import subprocess
import sys
import tempfile
import time
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))

from build_submission import build, output_path  # noqa: E402
from mock_api import MockApi  # noqa: E402

ALLOWED_THIRD_PARTY = {"httpx", "numpy"}  # то, что реально нужно решению; сверяется и с набором жюри
SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9_-]{16,}|sk-or-v1|sk-ws-|aliyuncs|openrouter\.ai")
TRICKY_ANSWER = 'Да, «можно», "конечно";\nвторая строка, с запятой. Какой регион?'


class Report:
    def __init__(self):
        self.rows = []

    def check(self, ok: bool, title: str, detail: str = ""):
        self.rows.append((bool(ok), title, detail))
        print(("OK   " if ok else "FAIL ") + title + (f" — {detail}" if detail else ""), flush=True)

    @property
    def failed(self) -> int:
        return sum(not ok for ok, _, _ in self.rows)

    def markdown(self) -> str:
        lines = ["## Сверка сабмита с техническим регламентом", "",
                 f"**{'✅ все проверки пройдены' if not self.failed else f'❌ не пройдено: {self.failed}'}**"
                 f" ({len(self.rows)} проверок)", "", "| | проверка | детали |", "|---|---|---|"]
        lines += [f"| {'✅' if ok else '❌'} | {t} | {d} |" for ok, t, d in self.rows]
        return "\n".join(lines) + "\n"


def check_archive(zip_path: Path, r: Report, *, final: bool = False) -> dict:
    z = zipfile.ZipFile(zip_path)
    names = z.namelist()
    r.check("solution.py" in names, "solution.py в корне архива")
    r.check("requirements.txt" in names, "requirements.txt в корне архива")
    r.check(all("/" not in n for n in names), "нет вложенных папок и внешней папки", ", ".join(names))
    r.check(all(n.endswith(".py") or n == "requirements.txt" for n in names),
            "только .py и requirements.txt: нет данных, индексов, конфигов, .whl")
    r.check(not any(n.startswith(("__MACOSX", ".")) for n in names), "нет служебных и скрытых файлов")
    r.check(not any(re.search(r"knowledge|questions|\.csv$|\.zip$|\.md$", n, re.I) for n in names),
            "нет базы знаний и проверочных вопросов")
    size = zip_path.stat().st_size
    r.check(size < 128 * 2**20, "размер архива меньше 128 МБ", f"{size // 1024} КБ")

    jury = {x.strip().lower() for x in (ROOT / "requirements.txt").read_text().splitlines() if x.strip()}
    reqs = [x.strip() for x in z.read("requirements.txt").decode().splitlines() if x.strip()]
    r.check(all("==" in x for x in reqs), "версии зависимостей зафиксированы", ", ".join(reqs))
    r.check(all(x.lower() in jury for x in reqs), "все зависимости — из набора жюри (requirements.txt организаторов)")

    sources = {n: z.read(n).decode("utf-8") for n in names if n.endswith(".py")}
    r.check(not any(re.search(r"pip\s+install|subprocess|os\.system", s) for s in sources.values()),
            "нет pip install и вызовов внешних команд")
    r.check(not any(SECRET_PATTERN.search(s) for s in sources.values()), "нет ключей и захардкоженных адресов API")
    imported, broken = set(), []
    for name, src in sources.items():
        try:
            tree = ast.parse(src)
        except SyntaxError as exc:
            broken.append(f"{name}: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module.split(".")[0])
    r.check(not broken, "все модули синтаксически корректны", "; ".join(broken))
    local = {n[:-3] for n in sources}
    third = sorted(m for m in imported - local if m not in sys.stdlib_module_names)
    req_names = {x.split("==")[0].lower() for x in reqs}
    external = {m.replace("_", "-") for m in third}
    allowed = ALLOWED_THIRD_PARTY | {"rank-bm25"} if final else ALLOWED_THIRD_PARTY
    r.check(external <= allowed and external <= req_names,
            "сторонние импорты есть в requirements.txt архива", ", ".join(third) or "нет")
    r.check("energybot" not in imported, "нет импортов из вложенного пакета (всё в корне)")
    s = sources.get("solution.py", "")
    r.check('"questions.csv"' in s and '"knowledge-base.zip"' in s and 'env("DATA_DIR", "data")' in s,
            "читает DATA_DIR/questions.csv и knowledge-base.zip, по умолчанию data/")
    llm_source = s if final else sources.get("eb_llm.py", "")
    r.check(all(v in llm_source for v in ('"LLM_BASE_URL"', '"LLM_API_KEY"', '"LLM_MODEL"')),
            "адрес, ключ и модель берутся из переменных окружения платформы")
    return {"reqs": reqs, "names": names}


def check_run(zip_path: Path, r: Report):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        app, data, work = tmp / "app", tmp / "data", tmp / "work"
        for d in (app, data, work):
            d.mkdir()
        zipfile.ZipFile(zip_path).extractall(app)
        venv.EnvBuilder(with_pip=True).create(tmp / "venv")
        py = tmp / "venv" / ("Scripts" if os.name == "nt" else "bin") / "python"
        pip = subprocess.run([str(py), "-m", "pip", "install", "-q", "--disable-pip-version-check", "-r",
                              str(app / "requirements.txt")], capture_output=True, text=True)
        r.check(pip.returncode == 0, "зависимости ставятся в чистое окружение только из requirements.txt архива",
                pip.stderr.strip()[-200:])
        if pip.returncode != 0:
            return
        (data / "questions.csv").write_bytes((ROOT / "demo_questions.csv").read_bytes())
        with zipfile.ZipFile(data / "knowledge-base.zip", "w") as kb:
            for p in sorted((ROOT / "knowledge-base").rglob("*.md")):
                kb.write(p, p.relative_to(ROOT / "knowledge-base").as_posix())
        with MockApi(reject_template_kwargs=False, responder=lambda m: TRICKY_ANSWER) as mock:
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp), "DATA_DIR": str(data),
                   "LLM_BASE_URL": mock.url, "LLM_API_KEY": "test-key", "LLM_MODEL": "qwen3.8-27b",
                   "MAX_WORKERS": "4", "TOP_K": "4", "MAX_TOKENS": "384", "TEMPERATURE": "0"}
            t0 = time.perf_counter()
            run = subprocess.run([str(py), str(app / "solution.py")], cwd=work, env=env,
                                 capture_output=True, text=True, timeout=600)
            elapsed = time.perf_counter() - t0
        r.check(run.returncode == 0, "solution.py завершается с кодом 0 в чистом окружении",
                f"{elapsed:.0f} c; {run.stderr.strip().splitlines()[-1] if run.stderr.strip() else ''}")
        out = work / "submission.csv"
        r.check(out.is_file(), "submission.csv создан в рабочем каталоге")
        if not out.is_file():
            return
        raw = out.read_bytes()
        try:
            text = raw.decode("utf-8")
            utf8 = True
        except UnicodeDecodeError:
            text, utf8 = raw.decode("utf-8", "replace"), False
        r.check(utf8, "submission.csv в UTF-8")
        rows = list(csv.reader(text.splitlines(True)))
        r.check(bool(rows) and rows[0] == ["id", "answer"], "заголовок ровно id,answer", str(rows[:1]))
        r.check(all(len(x) == 2 for x in rows), "ровно две колонки в каждой строке")
        with open(data / "questions.csv", encoding="utf-8-sig", newline="") as f:
            expected = [x["id"].strip() for x in csv.DictReader(f)]
        ids = [x[0] for x in rows[1:]]
        r.check(sorted(ids) == sorted(expected), "ответ на каждый ID из входного набора", f"{len(ids)} из {len(expected)}")
        r.check(len(set(ids)) == len(ids), "ID не повторяются")
        r.check(all(x[1].strip() for x in rows[1:]), "все ответы непустые")
        r.check(all(len(x[1]) <= 10000 for x in rows[1:]), "ответы не длиннее 10 000 символов")
        r.check(bool(rows[1:]) and rows[1][1].startswith('Да, «можно», "конечно"'),
                "запятые, кавычки и переносы внутри ответа корректно экранированы")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", type=Path)
    ap.add_argument("--final", action="store_true", help="проверить итоговый сабмит AIblanki")
    ap.add_argument("--report", help="куда записать markdown-отчёт")
    ap.add_argument("--no-run", action="store_true", help="только статические проверки, без запуска")
    args = ap.parse_args()
    zip_path = args.zip or output_path(args.final)
    r = Report()
    try:
        build(zip_path, final=args.final)
        r.check(True, "архив собирается scripts/build_submission.py", str(zip_path.relative_to(ROOT))
                if zip_path.is_relative_to(ROOT) else str(zip_path))
    except SystemExit as exc:
        r.check(False, "архив собирается scripts/build_submission.py", str(exc))
    if zip_path.is_file():
        check_archive(zip_path, r, final=args.final)
        if not args.no_run:
            check_run(zip_path, r)
    if args.report:
        Path(args.report).write_text(r.markdown(), encoding="utf-8")
    print(f"\nне пройдено: {r.failed} из {len(r.rows)}")
    sys.exit(1 if r.failed else 0)


if __name__ == "__main__":
    main()
