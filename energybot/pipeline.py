"""Конвейер ответа: разбор входа → поиск → промпт → LLM → постобработка."""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from .dialog import parse, search_queries
from .guard import MAX_WORDS, SENTENCE, repair_instruction, strip_sentences, unknown_numbers, word_count
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
    guard: dict = field(default_factory=dict)  # что сработало в проверке ответа (для отладки)


def extractive(chunks: list, max_words: int = 55) -> str:
    """Ответ без модели — начало самого релевантного раздела. Только на случай сбоя/нехватки времени:
    это лучше, чем пустая отписка, но хуже ответа модели."""
    if not chunks:
        return ""
    text = re.sub(r"(?m)^\s*-\s*", "", chunks[0].text)
    out = []
    for sentence in SENTENCE.split(" ".join(text.split())):
        if out and word_count(" ".join(out + [sentence])) > max_words:
            break
        out.append(sentence)
    answer = " ".join(out).strip()
    return f"{answer} Подробнее по вашему объекту подскажет специалист." if answer else ""


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
        self.top_k = env_num("EB_TOP_K", 10, 1, 30)
        self.n_candidates = env_num("EB_N_CANDIDATES", 20, 5, 60)
        self.expand_docs = env_num("EB_EXPAND_DOCS", 1, 0, 3)
        self.context_chars = env_num("EB_CONTEXT_CHARS", 18000, 2000, 60000)
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

    def retrieve(self, turns: list, query_vec=None, fast: bool = False):
        lexical, semantic, last = search_queries(turns)
        if query_vec is None and self.dense and not fast:
            query_vec = self.embed_queries([semantic])[0]
        ranked = self.retriever.search(lexical, query_vec, rerank_query=semantic, n_candidates=self.n_candidates,
                                       rerank=not fast)
        context = self.retriever.context(ranked, top_k=self.top_k, expand_docs=self.expand_docs,
                                         char_budget=self.context_chars)
        return ranked[: self.top_k], context

    def answer(self, question, mode: str = "eval", query_vec=None, fast: bool = False,
               offline: bool = False) -> Answer:
        """fast — без реранкера и без повторной генерации (нехватка времени);
        offline — без модели вообще (время вышло): выдержка из базы."""
        timings = {}
        t0 = time.perf_counter()
        turns = parse(question) if isinstance(question, str) else question
        hits, chunks = self.retrieve(turns, query_vec, fast=fast or offline)
        timings["retrieval"] = time.perf_counter() - t0
        sources = [(h.chunk.doc, h.chunk.path, round(float(h.score), 4)) for h in hits]
        sources += [(c.doc, c.path, None) for c in chunks[len(hits):]]
        materials = "\n\n".join(c.render() for c in chunks)
        if offline:
            timings["total"] = time.perf_counter() - t0
            return Answer(extractive(chunks) or FALLBACK, sources, timings, "без модели: лимит времени")
        messages = [{"role": "system", "content": system_prompt(materials, mode)}] + turns
        t1 = time.perf_counter()
        text, error = "", ""
        for attempt in range(1 if fast else 2):
            try:
                text = tidy(self.api.chat(messages))
                if text:
                    break
                error = "пустой ответ модели"
            except Exception as exc:  # noqa: BLE001 — на выходе всегда должен быть ответ
                error = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] LLM, попытка {attempt + 1}: {error}", file=sys.stderr)
        timings["generation"] = time.perf_counter() - t1
        guard = {}
        if text:
            t2 = time.perf_counter()
            text, guard = self.check(text, messages, materials, turns, fast)
            timings["guard"] = time.perf_counter() - t2
        timings["total"] = time.perf_counter() - t0
        if not text:
            return Answer(extractive(chunks) or FALLBACK, sources, timings, error or "пустой ответ", guard)
        return Answer(text, sources, timings, "", guard)

    def check(self, text: str, messages: list, materials: str, turns: list, fast: bool) -> tuple:
        """Числа — только из материалов и диалога, длина — в разумных пределах."""
        dialog = "\n".join(t["content"] for t in turns)
        bad = unknown_numbers(text, materials, dialog)
        too_long = word_count(text) > MAX_WORDS
        if not bad and not too_long:
            return text, {}
        guard = {"unknown_numbers": bad, "too_long": too_long}
        if not fast:
            try:
                fixed = tidy(self.api.chat(messages + [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": repair_instruction(bad, too_long)},
                ]))
                if fixed:
                    text, guard["repaired"] = fixed, True
            except Exception as exc:  # noqa: BLE001
                guard["repair_error"] = f"{type(exc).__name__}: {exc}"
        still_bad = unknown_numbers(text, materials, dialog)
        if still_bad:
            stripped = strip_sentences(text, still_bad)
            if word_count(stripped) >= 8:
                text, guard["stripped"] = stripped, still_bad
        return text, guard
