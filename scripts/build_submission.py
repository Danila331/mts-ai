"""Сборка ZIP для автоматической проверки: dist/submission.zip.

По техническому регламенту (docs/tech-regulations.md, раздел 4) платформа переносит
в окружение только корневые .py-файлы и requirements.txt, а данные, индексы и
конфигурации в архив класть нельзя. Поэтому пакет energybot/ при сборке
«расплющивается»: energybot/kb.py → eb_kb.py и т. д., импорты переписываются.

    python scripts/build_submission.py [--final] [--out PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path
from shutil import copyfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "energybot"
FINAL = ROOT / "submissions" / "final"
PREFIX = "eb_"


def flat_name(module: str) -> str:
    return f"{PREFIX}{module}"


def rewrite_imports(source: str) -> str:
    source = re.sub(r"^(\s*)from \.(\w+) import", lambda m: f"{m.group(1)}from {flat_name(m.group(2))} import",
                    source, flags=re.M)
    source = re.sub(r"^(\s*)from energybot\.(\w+) import",
                    lambda m: f"{m.group(1)}from {flat_name(m.group(2))} import", source, flags=re.M)
    leftovers = re.findall(r"^\s*(?:from \.|from energybot|import energybot).*$", source, flags=re.M)
    if leftovers:
        raise SystemExit(f"Не удалось переписать импорты: {leftovers}")
    return source


def check_requirements(path: Path) -> str:
    allowed = {x.strip().lower() for x in (ROOT / "requirements.txt").read_text().splitlines() if x.strip()}
    lines = [x.strip() for x in path.read_text().splitlines() if x.strip() and not x.startswith("#")]
    bad = [x for x in lines if x.lower() not in allowed]
    if bad:
        raise SystemExit(f"Зависимости вне разрешённого набора requirements.txt организаторов: {bad}")
    return "\n".join(lines) + "\n"


def output_path(final: bool) -> Path:
    return ROOT / "dist" / ("submission-final.zip" if final else "submission.zip")


def build_final(out: Path) -> list:
    original = FINAL / "original.zip"
    if out.resolve() == original.resolve():
        raise SystemExit("Укажи выходной путь вне исходного архива")
    check_requirements(FINAL / "requirements.txt")
    files = {name: (FINAL / name).read_bytes() for name in ("solution.py", "requirements.txt")}
    with zipfile.ZipFile(original) as archive:
        unchanged = all(archive.read(name) == data for name, data in files.items())
    out.parent.mkdir(parents=True, exist_ok=True)
    if unchanged:
        copyfile(original, out)
    else:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
    return list(files)


def build(out: Path, *, final: bool = False) -> list:
    if final:
        return build_final(out)
    files = {"solution.py": rewrite_imports((ROOT / "solution.py").read_text(encoding="utf-8"))}
    for module in sorted(PACKAGE.glob("*.py")):
        if module.name == "__init__.py":
            continue
        files[f"{flat_name(module.stem)}.py"] = rewrite_imports(module.read_text(encoding="utf-8"))
    files["requirements.txt"] = check_requirements(ROOT / "solution-requirements.txt")

    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    # Только корень архива, только .py и requirements.txt.
    assert all("/" not in n and (n.endswith(".py") or n == "requirements.txt") for n in names), names
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--final", action="store_true", help="сабмит AIblanki из submissions/final")
    args = ap.parse_args()
    out = args.out or output_path(args.final)
    names = build(out, final=args.final)
    print(f"{out} ({out.stat().st_size // 1024} КБ): {', '.join(names)}")


if __name__ == "__main__":
    sys.exit(main())
