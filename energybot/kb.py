"""Загрузка базы знаний и нарезка на фрагменты по заголовкам.

Разделы базы короткие (медиана ~350 символов), поэтому фрагмент = раздел
уровня ##/### целиком. Таблицы pandoc переводятся в строки
«колонка: значение», чтобы модель не путала столбцы при переносах строк.
"""

from __future__ import annotations

import hashlib
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# Разделы-ограничения: подмешиваются в контекст для найденного продукта.
GUARD_HEADINGS = (
    "чего утверждать нельзя",
    "факты, которые можно утверждать",
    "что мы не делаем",
    "не подходит",
)

COLUMN_SEP = re.compile(r"^\s*-{2,}(?:\s+-{2,})+\s*$")
FULL_RULE = re.compile(r"^\s*-{3,}\s*$")
HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
FILE_LINK = re.compile(r"`?(?:\.\./)?([0-9]{2}-[\w-]+/)?([0-9]{2}-[\w-]+\.md)`?")


@dataclass
class Chunk:
    id: str
    doc: str  # путь файла внутри базы, например 20-products/23-solar.md
    title: str  # заголовок документа (#)
    path: str  # цепочка заголовков раздела
    text: str  # нормализованный текст раздела без заголовка
    links: list = field(default_factory=list)  # файлы, на которые ссылается раздел

    @property
    def is_guard(self) -> bool:
        last = self.path.split(" > ")[-1].lower()
        return any(last.startswith(h) for h in GUARD_HEADINGS)

    def render(self) -> str:
        return f"[{self.doc} | {self.path}]\n{self.text}"

    def search_text(self) -> str:
        return f"{self.title}\n{self.path}\n{self.text}"


def _spans(sep_line: str):
    return [(m.start(), m.end()) for m in re.finditer(r"-+", sep_line)]


def _cut(line: str, spans) -> list:
    cells = []
    for i, (start, _) in enumerate(spans):
        end = spans[i + 1][0] if i + 1 < len(spans) else len(line)
        cells.append(line[start:end].strip() if len(line) > start else "")
    return cells


def _merge_rows(rows: list, spans) -> list:
    """Склеивает многострочные ячейки строки таблицы."""
    merged = [""] * len(spans)
    for line in rows:
        for i, cell in enumerate(_cut(line, spans)):
            if cell:
                merged[i] = (merged[i] + " " + cell).strip()
    return merged


def _format_row(header: list, cells: list) -> str:
    if not any(cells):
        return ""
    if any(header):
        parts = [f"{h}: {c}" if h else c for h, c in zip(header, cells) if c]
        return "- " + "; ".join(parts)
    return "- " + " — ".join(c for c in cells if c)


def normalize_tables(text: str) -> str:
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        if not COLUMN_SEP.match(lines[i]):
            out.append(lines[i])
            i += 1
            continue
        spans = _spans(lines[i])
        # Шапка: непустые строки над разделителем до рамки или пустой строки.
        header_lines = []
        while out and out[-1].strip() and not FULL_RULE.match(out[-1]):
            header_lines.insert(0, out.pop())
        multiline = bool(out) and FULL_RULE.match(out[-1]) is not None
        if multiline:
            out.pop()  # верхняя рамка
        header = _merge_rows(header_lines, spans) if header_lines else [""] * len(spans)
        i += 1
        rows_out = []
        if multiline or not header_lines:
            # Строки разделены пустыми строками, таблица закрывается рамкой.
            block = []
            while i < len(lines) and not FULL_RULE.match(lines[i]) and not COLUMN_SEP.match(lines[i]):
                if lines[i].strip():
                    block.append(lines[i])
                elif block:
                    rows_out.append(_format_row(header, _merge_rows(block, spans)))
                    block = []
                i += 1
            if block:
                rows_out.append(_format_row(header, _merge_rows(block, spans)))
            i += 1  # нижняя рамка
        else:
            # Простая таблица: одна строка = одна запись, конец на пустой строке.
            while i < len(lines) and lines[i].strip():
                rows_out.append(_format_row(header, _cut(lines[i], spans)))
                i += 1
        out.extend(r for r in rows_out if r)
    # Оставшиеся длинные линии — горизонтальные разделители.
    return "\n".join(l for l in out if not FULL_RULE.match(l))


LIST_ITEM = re.compile(r"^(?:-|\d+\.)\s+")


def _unwrap(text: str) -> str:
    """Склеивает жёсткие переносы pandoc внутри абзацев и пунктов списка."""
    out = []
    for line in text.split("\n"):
        stripped = line.strip()
        starts_block = not stripped or HEADING.match(stripped) or LIST_ITEM.match(stripped)
        if out and out[-1] and not starts_block and not HEADING.match(out[-1]):
            out[-1] += " " + stripped
        else:
            out.append(re.sub(r"^(-|\d+\.)\s+", r"\1 ", stripped))
    return "\n".join(out)


def clean(text: str) -> str:
    text = normalize_tables(text.replace("\r\n", "\n"))
    text = _unwrap(text)
    text = text.replace("---", "—").replace("--", "–").replace("**", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_document(doc: str, raw: str) -> list:
    text = clean(raw)
    title = doc
    stack = {}
    chunks = []
    body = []
    current = None

    def flush():
        if current is None:
            return
        content = "\n".join(body).strip()
        if not content:
            return
        path = " > ".join(stack[k] for k in sorted(stack) if k >= 2) or title
        links = sorted({m.group(2) for m in FILE_LINK.finditer(content)} - {Path(doc).name})
        cid = hashlib.sha1(f"{doc}|{path}|{content}".encode("utf-8")).hexdigest()[:16]
        chunks.append(Chunk(cid, doc, title, path, content, links))

    for line in text.split("\n"):
        m = HEADING.match(line)
        if m:
            flush()
            level, name = len(m.group(1)), m.group(2).strip()
            if level == 1:
                title = name
                stack = {}
            else:
                stack = {k: v for k, v in stack.items() if k < level}
                stack[level] = name
            current = level
            body = []
        else:
            if current is None:
                current = 1
            body.append(line)
    flush()
    return chunks


def read_sources(path: Path) -> dict:
    """Возвращает {относительный путь: текст} из ZIP-архива или папки."""
    sources = {}
    if path.is_file():
        with zipfile.ZipFile(path) as archive:
            for name in sorted(archive.namelist()):
                if name.startswith("__MACOSX/") or Path(name).suffix.lower() not in (".md", ".txt"):
                    continue
                sources[_strip_root(name)] = archive.read(name).decode("utf-8-sig", errors="replace")
    else:
        for file in sorted(path.rglob("*")):
            if file.suffix.lower() in (".md", ".txt") and file.is_file():
                sources[file.relative_to(path).as_posix()] = file.read_text(encoding="utf-8-sig")
    return {k: v for k, v in sources.items() if v.strip()}


def _strip_root(name: str) -> str:
    # В архиве организаторов файлы лежат без общей папки, но подстрахуемся.
    parts = Path(name).parts
    if len(parts) > 2 and parts[0] in ("knowledge-base", "knowledge_base", "kb"):
        parts = parts[1:]
    return "/".join(parts)


@dataclass
class KnowledgeBase:
    chunks: list
    fingerprint: str

    @classmethod
    def load(cls, path: Path) -> "KnowledgeBase":
        sources = read_sources(path)
        if not sources:
            raise ValueError(f"База знаний пуста: {path}")
        chunks = []
        for doc, raw in sources.items():
            chunks.extend(chunk_document(doc, raw))
        digest = hashlib.sha1("".join(c.id for c in chunks).encode()).hexdigest()[:16]
        return cls(chunks, digest)

    def by_doc(self, doc_name: str) -> list:
        return [c for c in self.chunks if Path(c.doc).name == doc_name or c.doc == doc_name]

    def guards(self, doc: str) -> list:
        return [c for c in self.chunks if c.doc == doc and c.is_guard]
