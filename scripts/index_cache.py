"""Кеш векторов базы знаний для ядра стенда (scripts/core_api.py).

Без кеша ядро на каждом старте считает эмбеддинги всей базы через API: это минуты до готовности и деньги
за каждую выкладку. С кешем — один запрос к модели на старте.

Ключ кеша — каталог <тексты>-<модель>:
  * тексты — хеш id и текста каждого фрагмента: правка базы или нарезки даёт новый ключ. Отпечаток базы
    (KnowledgeBase.fingerprint) для этого не годится — он считается по одним id фрагментов;
  * модель — вектор контрольной фразы. Имя модели не годится: за псевдонимом шлюза (energy-embed) модель
    может смениться незаметно для ядра, и старые векторы молча стали бы несовместимы с новыми запросами.
    Одна фраза — один запрос — ловит смену модели, провайдера и версии.

Модуль только для стенда: в сабмит (energybot/) он не входит, решение на платформе считает векторы само.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

CANARY = "Контрольная фраза кеша эмбеддингов: АСКУЭ, солнечная станция, тариф на электроэнергию."
# Сколько версий кеша держать: текущая и пара предыдущих — на случай отката выкладки.
KEEP = 3
# Знаков после запятой в отпечатке модели: меньше — сбой округления у одной и той же модели даёт промах
# (безопасно: просто пересчёт), больше — шум провайдера ломает попадания.
DIGITS = 2


def content_digest(kb) -> str:
    h = hashlib.sha256()
    for c in kb.chunks:
        h.update(c.id.encode("utf-8"))
        h.update(b"\0")
        h.update(c.search_text().encode("utf-8"))
        h.update(b"\1")
    return h.hexdigest()[:16]


def model_digest(api) -> str | None:
    """Отпечаток модели эмбеддингов; None — модель не ответила, кеш не используется."""
    try:
        vec = api.embed([CANARY])[0]
    except Exception as exc:  # noqa: BLE001 — без модели ядро работает на BM25, кеш ему не нужен
        print(f"[index] отпечаток модели не получен: {type(exc).__name__}: {exc}", file=sys.stderr)
        return None
    probe = [len(vec)] + [round(float(x), DIGITS) for x in vec[:32]]
    return hashlib.sha256(json.dumps(probe).encode()).hexdigest()[:16]


def index_dir(root: Path, kb, api) -> Path | None:
    model = model_digest(api)
    return None if model is None else root / f"{content_digest(kb)}-{model}"


def cached(path: Path | None) -> bool:
    return bool(path) and (path / "embeddings.npz").is_file() and (path / "meta.json").is_file()


def save(retriever, target: Path) -> bool:
    """Сохраняет векторы атомарно: сначала во временный каталог, потом переименование.

    Две реплики, посчитавшие индекс одновременно, не портят друг другу файлы: вторая просто не сможет
    переименовать свой каталог поверх готового и выбросит его.
    """
    if retriever.vectors is None or cached(target):
        return False
    # Кеш читается только в режиме крошек по умолчанию (Retriever._load_or_build_vectors): векторы другого
    # режима посчитаны по другому тексту и под этим ключом были бы ложью.
    if getattr(retriever, "crumbs", "path") != "path":
        return False
    tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        retriever.save_index(tmp)
        os.replace(tmp, target)
    except OSError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        if not cached(target):
            print(f"[index] кеш не записан: {exc}", file=sys.stderr)
        return False
    prune(target.parent, keep=KEEP)
    return True


def prune(root: Path, keep: int = KEEP, stale_tmp: float = 3600) -> None:
    """Удаляет старые версии кеша и брошенные временные каталоги."""
    now = time.time()
    versions = []
    for p in root.iterdir():
        if not p.is_dir():
            continue
        if ".tmp-" in p.name:
            if now - p.stat().st_mtime > stale_tmp:
                shutil.rmtree(p, ignore_errors=True)
            continue
        versions.append(p)
    versions.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for p in versions[keep:]:
        shutil.rmtree(p, ignore_errors=True)
