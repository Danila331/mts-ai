"""Сборка ZIP для автоматической проверки: dist/submission.zip.

По техническому регламенту (docs/tech-regulations.md, раздел 4) платформа переносит
в окружение только корневые .py-файлы и requirements.txt, а данные, индексы и
конфигурации в архив класть нельзя. Поэтому пакет energybot/ при сборке
«расплющивается»: energybot/kb.py → eb_kb.py и т. д., импорты переписываются.

    python scripts/build_submission.py [--out dist/submission.zip]
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "energybot"
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
    allowed = {l.strip().lower() for l in (ROOT / "requirements.txt").read_text().splitlines() if l.strip()}
    lines = [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.startswith("#")]
    bad = [l for l in lines if l.lower() not in allowed]
    if bad:
        raise SystemExit(f"Зависимости вне разрешённого набора requirements.txt организаторов: {bad}")
    return "\n".join(lines) + "\n"


def build(out: Path) -> list:
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
    ap.add_argument("--out", default=str(ROOT / "dist" / "submission.zip"))
    args = ap.parse_args()
    out = Path(args.out)
    names = build(out)
    print(f"{out} ({out.stat().st_size // 1024} КБ): {', '.join(names)}")


if __name__ == "__main__":
    sys.exit(main())
