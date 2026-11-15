"""Ворота govulncheck: падает на достижимых уязвимостях, кроме известных из списка исключений.

    govulncheck -format json ./... | python .github/scripts/govulncheck_gate.py backend/.govulncheck-ignore

Достижимая — та, до которой есть путь вызовов из нашего кода (в JSON у неё в trace есть функция).
Уязвимости в модулях, которые код не вызывает, только печатаются. Запись исключения, которой
govulncheck больше не находит, — предупреждение: её пора убрать.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def read_ignore(path: Path) -> dict[str, str]:
    ignored = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        entry, _, reason = line.partition("#")
        entry = entry.strip()
        if entry:
            ignored[entry] = reason.strip()
    return ignored


def read_stream(text: str) -> list[dict]:
    """govulncheck пишет поток JSON-объектов подряд, а не массив."""
    decoder, objects, pos = json.JSONDecoder(), [], 0
    while True:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            return objects
        obj, pos = decoder.raw_decode(text, pos)
        objects.append(obj)


def main() -> int:
    ignored = read_ignore(Path(sys.argv[1])) if len(sys.argv) > 1 else {}
    summaries, reachable, imported = {}, {}, set()
    for obj in read_stream(sys.stdin.read()):
        if "osv" in obj:
            summaries[obj["osv"]["id"]] = obj["osv"].get("summary", "")
        finding = obj.get("finding")
        if not finding:
            continue
        trace = finding.get("trace") or []
        if trace and trace[0].get("function"):
            reachable[finding["osv"]] = (trace[0].get("module", ""), finding.get("fixed_version") or "нет")
        else:
            imported.add(finding["osv"])

    failed = False
    for osv, (module, fixed) in sorted(reachable.items()):
        if osv in ignored:
            print(f"исключение  {osv} {module}: {ignored[osv]}")
            continue
        failed = True
        print(f"::error::{osv} {module} (исправлено в {fixed}): {summaries.get(osv, '')}")
    for osv in sorted(imported - set(reachable)):
        print(f"не вызывается  {osv}: {summaries.get(osv, '')}")
    for osv in sorted(set(ignored) - set(reachable)):
        print(f"::warning::{osv} больше не находится — уберите его из списка исключений")
    print("govulncheck: " + ("есть уязвимости вне исключений" if failed else "ok"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
