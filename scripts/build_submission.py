"""Сборка ZIP для автоматической проверки: dist/submission.zip.

В архив попадают solution.py, пакет energybot, предрасчитанный index/ (если есть)
и requirements.txt решения. База знаний, вопросы и ключи в архив НЕ кладутся —
платформа передаёт их сама.

    python scripts/build_submission.py
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FORBIDDEN = (".env", "knowledge-base", "demo_questions", "demo_output")


def main():
    DIST.mkdir(exist_ok=True)
    target = DIST / "submission.zip"
    files = [ROOT / "solution.py"] + sorted((ROOT / "energybot").glob("*.py"))
    index = ROOT / "index"
    if (index / "embeddings.npz").is_file():
        files += [index / "embeddings.npz", index / "meta.json"]
    else:
        print("Внимание: index/ нет — эмбеддинги базы будут считаться на платформе при запуске", file=sys.stderr)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            rel = f.relative_to(ROOT).as_posix()
            if any(part in rel for part in FORBIDDEN):
                sys.exit(f"В архив попал запрещённый файл: {rel}")
            z.write(f, rel)
        z.write(ROOT / "solution-requirements.txt", "requirements.txt")
    with zipfile.ZipFile(target) as z:
        names = z.namelist()
    print(f"{target} ({target.stat().st_size // 1024} КБ): {', '.join(names)}")


if __name__ == "__main__":
    main()
