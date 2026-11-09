"""Конвейер ответа: разбор входа → поиск → промпт → LLM → постобработка."""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from .dialog import parse, search_queries
from .kb import KnowledgeBase
from .llm import Api, env_num
from .prompts import system_prompt
from .retrieval import Retriever

FALLBACK = (
    "Точного ответа на этот вопрос в моих материалах нет, поэтому не буду гадать. "
    "Его лучше уточнить у специалиста МТС EnergyTool — он разберёт вашу ситуацию предметно."
)


@dataclass
class Answer:
    text: str
    sources: list = field(default_factory=list)  # [(doc, path, score)]
    timings: dict = field(default_factory=dict)
    error: str = ""


def tidy(text: str) -> str:
    """Убирает markdown и переносы: эталон — одна строка обычного текста."""
    text = re.sub(r"^\s*(?:Консультант|Ассистент)\s*:\s*", "", text.strip(), flags=re.I)
    text = re.sub(r"(?m)^\s*#{1,6}\s*", "", text)
    text = re.sub(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return " ".join(text.split())


class Consultant:
    def __init__(self, kb_path: Path, index_dir: Path | None = None, api: Api | None = None):
        t0 = time.perf_counter()
        self.kb = KnowledgeBase.load(kb_path)
        self.api = api or Api()
        self.retriever = Retriever(self.kb, self.api if self.api.configured else None, index_dir,
                                   dense=self.api.use_embeddings)
        self.dense = self.retriever.vectors is not None
        self.top_k = env_num("TOP_K", 6, 1, 20)
        self.n_candidates = env_num("N_CANDIDATES", 20, 5, 60)
        print(
            f"[consultant] фрагментов: {len(self.kb.chunks)}, dense: {self.dense}, "
            f"загрузка {time.perf_counter() - t0:.1f} c",
            file=sys.stderr,
        )

    def embed_queries(self, semantic_queries: list) -> list:
        if not self.dense:
            return [None] * len(semantic_queries)
        try:
            return self.api.embed(semantic_queries)
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] эмбеддинги вопросов недоступны: {exc}", file=sys.stderr)
            return [None] * len(semantic_queries)

    def retrieve(self, turns: list, query_vec=None):
        lexical, semantic, last = search_queries(turns)
        if query_vec is None and self.dense:
            query_vec = self.embed_queries([semantic])[0]
        hits = self.retriever.search(lexical, query_vec, rerank_query=semantic,
                                     n_candidates=self.n_candidates, top_k=self.top_k)
        return hits, self.retriever.context(hits)

    def answer(self, question, mode: str = "eval", query_vec=None) -> Answer:
        timings = {}
        t0 = time.perf_counter()
        turns = parse(question) if isinstance(question, str) else question
        hits, chunks = self.retrieve(turns, query_vec)
        timings["retrieval"] = time.perf_counter() - t0
        sources = [(h.chunk.doc, h.chunk.path, round(float(h.score), 4)) for h in hits]
        sources += [(c.doc, c.path, None) for c in chunks[len(hits):]]
        materials = "\n\n".join(c.render() for c in chunks)
        messages = [{"role": "system", "content": system_prompt(materials, mode)}] + turns
        t1 = time.perf_counter()
        text, error = "", ""
        for attempt in range(2):
            try:
                text = tidy(self.api.chat(messages))
                if text:
                    break
                error = "пустой ответ модели"
            except Exception as exc:  # noqa: BLE001 — на выходе всегда должен быть ответ
                error = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] LLM, попытка {attempt + 1}: {error}", file=sys.stderr)
        timings["generation"] = time.perf_counter() - t1
        timings["total"] = time.perf_counter() - t0
        return Answer(text or FALLBACK, sources, timings, "" if text else error)
