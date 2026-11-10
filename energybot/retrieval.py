"""Гибридный поиск: BM25 + плотные эмбеддинги bge-m3 + реранкер Qwen3.

Каждая ступень опциональна: если API эмбеддингов или реранкера недоступен,
поиск деградирует до BM25, а не падает.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .kb import Chunk, KnowledgeBase
from .text import tokens

# Общие правила консультации нужны в любом ответе.
ALWAYS_DOC = "02-product-scope-and-limits.md"
ALWAYS_SECTIONS = ("Общие границы", "Когда требуется специалист")
REFERENCE_PREFIX = "00-reference/"


class BM25:
    def __init__(self, docs: list, k1: float = 1.4, b: float = 0.7):
        self.k1, self.b = k1, b
        self.tf = [Counter(d) for d in docs]
        self.len = [len(d) for d in docs]
        self.avg = sum(self.len) / max(1, len(docs))
        df = Counter(t for d in docs for t in set(d))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def scores(self, query: list) -> np.ndarray:
        out = np.zeros(len(self.tf))
        q = Counter(query)
        for i, tf in enumerate(self.tf):
            norm = self.k1 * (1 - self.b + self.b * self.len[i] / self.avg)
            s = 0.0
            for term, qf in q.items():
                f = tf.get(term)
                if f:
                    s += self.idf[term] * f * (self.k1 + 1) / (f + norm) * (1 + 0.5 * (qf - 1))
            out[i] = s
        return out


class CharTfidf:
    """TF-IDF по символьным n-граммам внутри слов — как TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5)).

    Ловит то, что стеммер режет по-разному: падежи и словообразование («шиферная» — «шифер»), опечатки,
    составные и латинские слова (АСКУЭ, ОРЭМ, SIM). Своя реализация на словарях, чтобы не тащить
    scikit-learn в сабмит: база — пара сотен разделов, обратный индекс считается за доли секунды."""

    WORD = re.compile(r"\w+")

    def __init__(self, docs: list, lo: int = 3, hi: int = 5):
        self.lo, self.hi, self.n = lo, hi, len(docs)
        counts = [self._grams(d) for d in docs]
        df = Counter(g for c in counts for g in c)
        # Сглаженный idf, как в scikit-learn по умолчанию.
        self.idf = {g: math.log((1 + self.n) / (1 + f)) + 1 for g, f in df.items()}
        self.postings = defaultdict(list)  # n-грамма → [(номер раздела, вес)]
        for i, c in enumerate(counts):
            for g, w in self._weigh(c).items():
                self.postings[g].append((i, w))

    def _grams(self, text: str) -> Counter:
        out = Counter()
        for word in self.WORD.findall(text.lower().replace("ё", "е")):
            padded = f" {word} "
            if len(padded) < self.lo:
                continue
            for n in range(self.lo, self.hi + 1):
                if n > len(padded):
                    break
                for i in range(len(padded) - n + 1):
                    out[padded[i:i + n]] += 1
        return out

    def _weigh(self, counts: Counter) -> dict:
        vec = {g: c * self.idf[g] for g, c in counts.items() if g in self.idf}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        return {g: v / norm for g, v in vec.items()}

    def scores(self, query: str) -> np.ndarray:
        out = np.zeros(self.n)
        for g, w in self._weigh(self._grams(query)).items():
            for i, d in self.postings.get(g, ()):
                out[i] += w * d
        return out


# Qwen3-Reranker — модель «да/нет» поверх чат-шаблона; инструкцию и шаблон собираем на клиенте
# (как в примере vLLM для Qwen3-Reranker). EB_RERANK_TEMPLATE: qwen — полный шаблон, instruct — только
# строки <Instruct>/<Query>, raw — запрос и раздел как есть (если прокси сам применяет шаблон).
RERANK_INSTRUCTION = ("Given a customer question to an energy services consultant (MTS EnergyTool), "
                      "judge whether this knowledge base section helps answer it")
RERANK_PREFIX = ("<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and "
                 "the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n"
                 "<|im_start|>user\n")
RERANK_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


def rerank_inputs(query: str, documents: list, template: str = "raw") -> tuple:
    if template == "qwen":
        return (f"{RERANK_PREFIX}<Instruct>: {RERANK_INSTRUCTION}\n<Query>: {query}\n",
                [f"<Document>: {d}{RERANK_SUFFIX}" for d in documents])
    if template == "instruct":
        return f"<Instruct>: {RERANK_INSTRUCTION}\n<Query>: {query}", documents
    return query, documents


@dataclass
class Hit:
    chunk: Chunk
    score: float
    stage: str


class Retriever:
    def __init__(self, kb: KnowledgeBase, api=None, index_dir: Path | None = None, dense: bool = True,
                 char_ngrams: bool = False):
        self.kb = kb
        self.api = api
        # Путь и заголовок документа повторяются, чтобы вопросы FAQ в заголовках весили больше.
        self.bm25 = BM25([tokens(f"{c.path} {c.path} {c.title} {c.text}") for c in kb.chunks])
        # Мини-индекс справочника 00-reference (поиск из feature/verify-ensemble): в контекст подмешивается
        # лучший справочный раздел по запросу.
        self.ref_chunks = [c for c in kb.chunks if c.doc.startswith(REFERENCE_PREFIX)]
        self.ref_bm25 = BM25([tokens(f"{c.path} {c.text}") for c in self.ref_chunks]) if self.ref_chunks else None
        # Третий лексический канал (EB_ARCH=factmap): символьные n-граммы.
        self.chars = CharTfidf([f"{c.path} {c.title} {c.text}" for c in kb.chunks]) if char_ngrams else None
        self.order = {c.id: i for i, c in enumerate(kb.chunks)}
        self.vectors = None
        if api is not None and dense:
            self.vectors = self._load_or_build_vectors(index_dir)

    # ---------- плотные векторы ----------
    def _load_or_build_vectors(self, index_dir: Path | None):
        cached = {}
        if index_dir and (index_dir / "embeddings.npz").is_file():
            data = np.load(index_dir / "embeddings.npz")
            meta = json.loads((index_dir / "meta.json").read_text(encoding="utf-8"))
            cached = dict(zip(meta["ids"], data["vectors"]))
        missing = [c for c in self.kb.chunks if c.id not in cached]
        if missing:
            try:
                vecs = self.api.embed([c.search_text() for c in missing])
                cached.update({c.id: v for c, v in zip(missing, vecs)})
            except Exception as exc:  # noqa: BLE001 — поиск должен жить без эмбеддингов
                print(f"[retrieval] эмбеддинги недоступны: {exc}; работаем на BM25", file=sys.stderr)
                return None
        matrix = np.array([cached[c.id] for c in self.kb.chunks], dtype=np.float32)
        matrix /= np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9
        return matrix

    def save_index(self, index_dir: Path):
        if self.vectors is None:
            raise RuntimeError("Нет векторов для сохранения")
        index_dir.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(index_dir / "embeddings.npz", vectors=self.vectors)
        meta = {"ids": [c.id for c in self.kb.chunks], "fingerprint": self.kb.fingerprint}
        (index_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # ---------- поиск ----------
    def candidates(self, query: str, query_vec=None, n: int = 20, exclude: set | None = None,
                   char_query: str | None = None) -> list:
        """Reciprocal Rank Fusion (k=60) каналов: BM25, символьные n-граммы (если включены), bge-m3.
        exclude — id разделов, которые искать не нужно (например, уже стоящие в карте фактов)."""
        lex = self.bm25.scores(tokens(query, expand=True))
        ranks = [np.argsort(-lex)]
        if self.chars is not None:
            ranks.append(np.argsort(-self.chars.scores(char_query or query), kind="stable"))
        # Несовпадение размерности — индекс посчитан другой моделью: работаем без плотного канала.
        if self.vectors is not None and query_vec is not None and len(query_vec) == self.vectors.shape[1]:
            q = np.asarray(query_vec, dtype=np.float32)
            q /= np.linalg.norm(q) + 1e-9
            with np.errstate(all="ignore"):
                sims = np.nan_to_num(self.vectors @ q, nan=0.0, posinf=0.0, neginf=0.0)
            ranks.append(np.argsort(-sims))
        fused = Counter()
        for order in ranks:
            r = 0
            for idx in order:
                if r >= 60:
                    break
                if exclude and self.kb.chunks[int(idx)].id in exclude:
                    continue
                fused[int(idx)] += 1.0 / (60 + r)
                r += 1
        return [Hit(self.kb.chunks[i], s, "rrf") for i, s in fused.most_common(n)]

    def search(self, query: str, query_vec=None, rerank_query: str | None = None,
               n_candidates: int = 20, rerank: bool = True, exclude: set | None = None,
               template: str = "raw", char_query: str | None = None) -> list:
        """Кандидаты, упорядоченные по релевантности (после реранкера, если он доступен)."""
        hits = self.candidates(query, query_vec, n_candidates, exclude, char_query)
        if rerank and self.api is not None and self.api.can_rerank and hits:
            try:
                scores = self.api.rerank(*rerank_inputs(rerank_query or query, [h.chunk.render() for h in hits],
                                                        template))
                hits = [Hit(h.chunk, scores[i], "rerank") for i, h in enumerate(hits)]
                hits.sort(key=lambda h: -h.score)
            except Exception as exc:  # noqa: BLE001
                print(f"[retrieval] реранкер недоступен: {exc}", file=sys.stderr)
        return hits

    def context(self, ranked: list, top_k: int = 10, expand_docs: int = 1, char_budget: int = 18000,
                max_guard_docs: int = 2, ref_query: str = "") -> list:
        """Контекст для модели.

        Обязательная часть (бюджетом не урезается): top_k лучших фрагментов, разделы
        «Факты, которые можно утверждать» / «Чего утверждать нельзя» по найденным продуктам
        и общие границы консультации. Дополнительно — другие разделы самых релевантных
        документов, пока помещаются в char_budget: эталон часто опирается на соседние
        разделы того же документа (на рабочей части выборки это подняло долю найденных
        разделов с 0,53 до ~0,76).
        """
        main = [h.chunk for h in ranked[:top_k]]
        seen = {c.id for c in main}
        rules = []

        def add(target, chunk):
            if chunk.id not in seen:
                target.append(chunk)
                seen.add(chunk.id)

        product_docs = []
        for c in main:
            if c.doc.startswith("20-products/") and c.doc not in product_docs:
                product_docs.append(c.doc)
        for doc in product_docs[:max_guard_docs]:
            for g in self.kb.guards(doc):
                if g.path.lower().startswith(("факты", "чего утверждать")):
                    add(rules, g)
        for c in self.kb.chunks:
            if c.doc.endswith(ALWAYS_DOC) and c.path in ALWAYS_SECTIONS:
                add(rules, c)
        if ref_query and self.ref_bm25:  # лучший справочный раздел по запросу
            scores = self.ref_bm25.scores(tokens(ref_query, expand=True))
            best = int(np.argmax(scores)) if scores.size else -1
            if best >= 0 and scores[best] > 0:
                add(rules, self.ref_chunks[best])

        extra = []
        if expand_docs > 0:
            doc_score = defaultdict(float)
            for h in ranked[:20]:
                if math.isfinite(h.score):
                    doc_score[h.chunk.doc] += max(0.0, float(h.score))
            top_docs = [d for d, _ in sorted(doc_score.items(), key=lambda x: -x[1])[:expand_docs]]
            rank_pos = {h.chunk.id: i for i, h in enumerate(ranked)}
            pool = [c for c in self.kb.chunks if c.doc in top_docs and c.id not in seen]
            pool.sort(key=lambda c: rank_pos.get(c.id, len(ranked) + self.order[c.id]))
            size = sum(len(c.render()) for c in main + rules)
            for c in pool:
                length = len(c.render())
                if size + length <= char_budget:
                    add(extra, c)
                    size += length
        return main + extra + rules

    # ---------- контекст «справочник + документы целиком» ----------
    def reference(self) -> list:
        """Справочные документы (карта продуктов, числа, границы, состав данных для расчёта).
        Нужны почти в каждом ответе и одинаковы для всех вопросов — идут в неизменяемую часть промпта."""
        return [c for c in self.kb.chunks if c.doc.startswith(REFERENCE_PREFIX)]

    def rank_docs(self, ranked: list, depth: int = 20) -> list:
        """Документы по убыванию релевантности: вклад фрагмента убывает с его местом в выдаче."""
        score = defaultdict(float)
        for pos, h in enumerate(ranked[:depth]):
            if not h.chunk.doc.startswith(REFERENCE_PREFIX):
                score[h.chunk.doc] += 1.0 / (3 + pos)
        return [d for d, _ in sorted(score.items(), key=lambda x: -x[1])]

    def materials(self, ranked: list, top_k: int = 8, full_docs: int = 2, char_budget: int = 40000,
                  skip_reference: bool = True) -> tuple:
        """Материалы по вопросу: самые релевантные документы целиком + лучшие фрагменты остальных.

        Документы базы небольшие (3–17 тыс. символов) и написаны связно: «Кому подходит»,
        «Что мы не делаем», «Частые вопросы», «Чего утверждать нельзя». Эталон обычно собран из
        нескольких разделов одного документа, поэтому документ целиком надёжнее набора фрагментов.
        Возвращает (документы целиком, отдельные фрагменты).
        """
        skip = {c.id for c in self.reference()} if skip_reference else set()
        docs = []
        size = 0
        for doc in self.rank_docs(ranked)[:full_docs]:
            length = sum(len(c.render()) for c in self.kb.chunks if c.doc == doc)
            if docs and size + length > char_budget:
                continue
            docs.append(doc)
            size += length
        extra = []
        for h in ranked:
            c = h.chunk
            if len(extra) >= top_k:
                break
            if c.id in skip or c.doc in docs:
                continue
            if size + len(c.render()) > char_budget:
                continue
            extra.append(c)
            size += len(c.render())
        return docs, extra

    def render_doc(self, doc: str) -> str:
        chunks = [c for c in self.kb.chunks if c.doc == doc]
        title = chunks[0].title if chunks else doc
        body = "\n\n".join(f"## {c.path}\n{c.text}" if c.path != c.title else c.text for c in chunks)
        return f"=== Документ «{title}» ({doc}) ===\n{body}"
