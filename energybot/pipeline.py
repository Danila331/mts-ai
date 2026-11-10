"""Конвейер ответа: разбор входа → поиск → промпт → LLM → постобработка."""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from .dialog import parse, search_queries
from .factmap import (
    LLM_RERANK_SYSTEM,
    TOC_SYSTEM,
    build_condense_messages,
    build_fm_messages,
    clean_condensed,
    fact_map_chunks,
    needs_condense,
    parse_marks,
    render_fact_map,
)
from .guard import MAX_WORDS, SENTENCE, repair_instruction, strip_sentences, unknown_numbers, word_count
from .kb import KnowledgeBase
from .llm import Api, context_overflow, env, env_num, strip_thinking
from .prompts import (
    CHECK_NOTE,
    CHECK_TAIL,
    EVIDENCE_INLINE_TAIL,
    EVIDENCE_TAIL,
    REFINE,
    build_check_messages,
    build_draft_messages,
    build_messages,
    build_write_messages,
    evidence_note,
    parse_check,
    parse_evidence,
    render_dialog,
    render_examples,
    split_inline_evidence,
    split_plan,
)
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
    trace: str = ""  # фактическая основа ответа при двух шагах (для отладки)


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
        # Схема ответа: v3 — справочник + документы целиком (подтверждена платформой); factmap — карта фактов +
        # поиск по разделам + проверка чисел (energybot/factmap.py).
        self.arch = env("EB_ARCH", "v3")
        self.retriever = Retriever(self.kb, self.api if self.api.configured else None, index_dir,
                                   dense=self.api.use_embeddings, char_ngrams=self.arch == "factmap")
        self.dense = self.retriever.vectors is not None
        self.top_k = env_num("EB_TOP_K", 8, 0, 30)
        self.n_candidates = env_num("EB_N_CANDIDATES", 30, 5, 80)
        # Сколько самых релевантных документов давать модели целиком и общий бюджет материалов.
        self.full_docs = env_num("EB_FULL_DOCS", 2, 0, 6)
        self.context_chars = env_num("EB_CONTEXT_CHARS", 40000, 2000, 200000)
        self.use_examples = env("EB_EXAMPLES", "1") != "0"
        # Только для локальной оценки на демо-наборе: не показывать модели пример с тем же вопросом.
        self.examples_loo = env("EB_EXAMPLES_LOO", "0") == "1"
        # Размышления модели при генерации (сколько вопросов их получит, решает бюджет времени в solution.py).
        # По умолчанию выключены: прирост виден только на 18 эталонах организаторов, а на платформе прогон
        # без размышлений уже занимает ~700 c из 1200.
        self.think = env("EB_THINK", "0") == "1"
        self.think_brief = env("EB_THINK_BRIEF", "0") == "1"  # просить модель рассуждать коротко
        self.think_ok = self.think_failed = 0  # предохранитель: сервер не тянет размышления — не тратим время
        # Разбор вопроса перед ответом в том же вызове: 0 — нет, 1 — короткий, 2 — с цитатами из базы.
        self.plan = env_num("EB_PLAN", 0, 0, 2)
        # Сколько ближайших эталонов повторять перед вопросом. По умолчанию 0: на эталонах организаторов это
        # давало 0,744 против 0,601, а на платформе — 0,525 против 0,557 (соседний пример уводит ответ в сторону).
        self.near = env_num("EB_NEAR", 0, 0, 8)
        self.style = env("EB_STYLE", "tight")  # tight — как эталон по длине, full — упор на полноту
        # Опора из базы: отдельный вызов выписывает цитаты, отмечает, чего в базе нет, и сверяет применимость.
        # 1 — отдельным вызовом перед ответом, 2 — в том же вызове, что и ответ (дешевле по времени).
        self.evidence = env_num("EB_EVIDENCE", 0, 0, 2)
        # Проверка «есть ли в базе то, о чём спросили» перед генерацией: 1 — отдельным промптом,
        # 2 — хвостом к обычному запросу (общий кэшируемый префикс). Генератор получает указание, только
        # когда проверка говорит «нет»; на остальных вопросах запрос остаётся прежним.
        self.check_kb = env_num("EB_CHECK", 0, 0, 2)
        # Два шага: фактическая основа по небольшому набору разделов → оформление в ответ эксперта.
        self.two_stage = env("EB_TWO_STAGE", "0") == "1"
        self.draft_k = env_num("EB_DRAFT_K", 10, 3, 30)
        self.refine = env("EB_REFINE", "0") == "1"  # второй проход: сверка черновика с базой
        # Вся база в неизменной части промпта: база мала (~33 тыс. токенов), а кэш префикса на сервере
        # модели делает это дешёвым. Если сервер ответит, что контекст не помещается, — режим отключается
        # и дальше работает схема «справочник + документы целиком».
        self.full_kb = env("EB_FULL_KB", "0") == "1"
        self.reference_text = "\n\n".join(c.render() for c in self.retriever.reference())
        if env("EB_REFERENCE", "1") == "0":
            self.reference_text = ""
        self.kb_text = "\n\n".join(self.retriever.render_doc(d) for d in dict.fromkeys(c.doc for c in self.kb.chunks))
        # Настройки схемы factmap. Сэмплинг — для коротких фактических ответов (карточка Qwen для режима без
        # размышлений советует temperature 0.7 и presence_penalty 1.5; это сознательное отступление).
        fm = fact_map_chunks(self.kb) if self.arch == "factmap" else []
        self.fact_map = render_fact_map(fm)
        self.fm_ids = {c.id for c in fm}
        self.fm_candidates = env_num("EB_FM_CANDIDATES", 12, 3, 60)
        self.fm_top = env_num("EB_FM_TOP", 5, 1, 30)
        self.fm_condense = env("EB_FM_CONDENSE", "1") != "0"
        self.rerank_template = env("EB_RERANK_TEMPLATE", "qwen")
        # Промпт схемы factmap: fm — свой (energybot/factmap.py), v3 / jury — правила v3 и выверенные по эталонам.
        self.fm_prompt = env("EB_FM_PROMPT", "fm")
        # Родительский документ (Райс, Enterprise RAG Challenge 2): ищем мелкими разделами, а модели отдаём
        # N самых релевантных документов целиком + остальные найденные разделы.
        self.fm_parent = env_num("EB_FM_PARENT", 0, 0, 4)
        # LLM-реранк кандидатов (0,3 · скор поиска + 0,7 · оценка модели) и отбор разделов по оглавлению
        # (идея PageIndex) — каждый стоит один вызов модели на вопрос.
        self.fm_llm_rerank = env("EB_FM_LLMRERANK", "0") == "1"
        self.fm_toc = env("EB_FM_TOC", "0") == "1"
        self.fm_reverse = env("EB_FM_REVERSE", "0") == "1"
        # Поиск для схемы v3: v3 — документы целиком; ve — поисковый движок из feature/verify-ensemble
        # (фрагменты + соседние разделы главного документа в 10 тыс. символов, лучший справочный раздел,
        # окно истории — 3 последние реплики клиента).
        self.search = env("EB_SEARCH", "v3")
        self.fm_max_tokens = env_num("EB_FM_MAX_TOKENS", 600, 128, 4096)
        self.fm_temperature = env_num("EB_FM_TEMPERATURE", 0.3, 0.0, 2.0, float)
        self.fm_sampling = {"top_p": env_num("EB_FM_TOP_P", 0.8, 0.05, 1.0, float),
                            "top_k": env_num("EB_FM_TOP_K", 20, 1, 200),
                            "presence_penalty": env_num("EB_FM_PRESENCE", 0.0, 0.0, 2.0, float)}
        print(
            f"[consultant] схема {self.arch}, фрагментов: {len(self.kb.chunks)}, dense: {self.dense}, "
            f"справочник: {len(self.reference_text)} симв., карта фактов: {len(self.fact_map)} симв., "
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

    def retrieve(self, turns: list, query_vec=None, fast: bool = False, compact: bool = False):
        """Возвращает (лучшие фрагменты выдачи, документы целиком, отдельные фрагменты)."""
        if self.search == "ve":
            lexical, semantic, _last = search_queries(turns, window=3)
            if query_vec is None and self.dense and not fast:
                query_vec = self.embed_queries([semantic])[0]
            ranked = self.retriever.search(lexical, query_vec, rerank_query=semantic,
                                           n_candidates=env_num("EB_VE_CANDIDATES", 20, 5, 80), rerank=not fast)
            chunks = self.retriever.context(ranked, top_k=env_num("EB_VE_TOP_K", 10, 1, 30), expand_docs=1,
                                            char_budget=env_num("EB_VE_CONTEXT_CHARS", 10000, 2000, 60000),
                                            ref_query=lexical)
            return ranked, [], chunks
        lexical, semantic, last = search_queries(turns)
        if query_vec is None and self.dense and not fast:
            query_vec = self.embed_queries([semantic])[0]
        ranked = self.retriever.search(lexical, query_vec, rerank_query=semantic, n_candidates=self.n_candidates,
                                       rerank=not fast)
        docs, extra = self.retriever.materials(
            ranked, top_k=self.top_k, full_docs=1 if compact else self.full_docs,
            char_budget=self.context_chars // 3 if compact else self.context_chars,
            skip_reference=bool(self.reference_text))
        return ranked, docs, extra

    def render_materials(self, docs: list, extra: list) -> str:
        parts = [self.retriever.render_doc(d) for d in docs]
        if extra:
            head = "=== Фрагменты других документов ===\n" if docs else ""
            parts.append(head + "\n\n".join(c.render() for c in extra))
        return "\n\n".join(parts)

    def generate(self, messages: list, think: bool, attempts: int, plan: bool = False) -> tuple:
        """Ответ модели. С размышлениями — одна попытка; не уложилась или упала — обычные попытки без них."""
        text, error = "", ""
        # Если размышления раз за разом не укладываются в тайм-аут, дальше их не запрашиваем.
        if think and self.think_failed >= 4 and self.think_ok * 3 < self.think_failed:
            think = False
        modes = ([True] if think else []) + [False] * attempts
        for attempt, with_thinking in enumerate(modes):
            try:
                raw = self.api.chat(messages, think=with_thinking)
                text = tidy(split_plan(raw) if plan else raw)
                if with_thinking:
                    self.think_ok += bool(text)
                    self.think_failed += not text
                if text:
                    return text, ""
                error = "пустой ответ модели"
            except Exception as exc:  # noqa: BLE001 — на выходе всегда должен быть ответ
                self.think_failed += with_thinking
                error = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] LLM, попытка {attempt + 1}: {error}", file=sys.stderr)
                response = getattr(exc, "response", None)
                if response is not None and context_overflow(response):
                    return "", "overflow"
        return text, error

    @property
    def has_extra(self) -> bool:
        """Есть ли у решения дорогие шаги, которые бюджет времени выдаёт по запасу."""
        # Опора в том же вызове (EB_EVIDENCE=2) по времени почти бесплатна и сюда не входит.
        if self.arch == "factmap":
            return False
        return self.think or self.evidence == 1 or bool(self.check_kb)

    def answer(self, question, mode: str = "eval", query_vec=None, fast: bool = False,
               offline: bool = False, premium: bool = True) -> Answer:
        """fast — без реранкера, дорогих шагов и повторных проходов (нехватка времени);
        offline — без модели вообще (время вышло): выдержка из базы;
        premium — разрешены ли для этого вопроса дорогие шаги: размышления (EB_THINK) и опора из базы
        (EB_EVIDENCE). Без них вопрос отвечается одним обычным вызовом."""
        turns = parse(question) if isinstance(question, str) else question
        if self.arch == "factmap":
            return self.answer_factmap(turns, mode, query_vec, fast, offline)
        timings = {}
        t0 = time.perf_counter()
        # В быстром режиме контекст тоже сокращается: время ответа модели растёт с длиной промпта.
        ranked, docs, extra = self.retrieve(turns, query_vec, fast=fast or offline, compact=fast)
        timings["retrieval"] = time.perf_counter() - t0
        sources = [(d, "весь документ", None) for d in docs]
        sources += [(c.doc, c.path, None) for c in extra]
        top_chunks = [h.chunk for h in ranked[:max(5, self.top_k)]]
        if offline:
            timings["total"] = time.perf_counter() - t0
            return Answer(extractive(top_chunks) or FALLBACK, sources, timings, "без модели: лимит времени")
        exclude = ""
        if self.examples_loo:
            exclude = turns[0]["content"] if len(turns) == 1 else "\n".join(
                ("Пользователь: " if t["role"] == "user" else "Ассистент: ") + t["content"] for t in turns)
        t1 = time.perf_counter()
        premium = premium and not fast
        think = self.think and premium
        text, error, messages, materials = "", "", [], ""
        draft = ""
        if self.two_stage and not fast:
            focus = [h.chunk for h in ranked[: self.draft_k]]
            materials = "\n\n".join(c.render() for c in focus)
            try:
                draft = self.api.chat(build_draft_messages(materials, turns)).strip()
            except Exception as exc:  # noqa: BLE001 — без основы отвечаем обычным одним вызовом
                print(f"[consultant] основа ответа: {type(exc).__name__}: {exc}", file=sys.stderr)
            if draft:
                messages = build_write_messages(materials, turns, draft, mode, self.use_examples, exclude)
                text, error = self.generate(messages, think=think, attempts=2)
        if not text and self.full_kb and not fast:
            materials = "\n\n".join(c.render() for c in top_chunks[: self.top_k] or top_chunks)
            messages = build_messages(self.kb_text, materials, turns, mode, self.use_examples, exclude, full_kb=True,
                                      plan=self.plan, style=self.style, near=self.near)
            text, error = self.generate(messages, think=think, attempts=1 if fast else 2, plan=bool(self.plan))
            if error == "overflow":
                print("[consultant] вся база не помещается в контекст модели — дальше без неё", file=sys.stderr)
                self.full_kb = False
        if not text and (fast or not self.full_kb):
            materials = self.render_materials(docs, extra)
            note = ""
            if self.evidence == 2 and not fast:
                # Опора и ответ одним вызовом; если формат не соблюдён — ниже обычный ответ без опоры.
                inline = build_messages(self.reference_text, materials, turns, mode, self.use_examples, exclude,
                                        style=self.style, task=EVIDENCE_INLINE_TAIL)
                try:
                    answer, draft = split_inline_evidence(self.api.chat(inline, think=think))
                    text = tidy(answer)
                    if text:
                        messages = inline
                except Exception as exc:  # noqa: BLE001
                    print(f"[consultant] опора в ответе: {type(exc).__name__}: {exc}", file=sys.stderr)
            elif self.evidence and premium:
                try:
                    raw = self.api.chat(build_messages(
                        self.reference_text, materials, turns, mode, self.use_examples, exclude,
                        style=self.style, task=EVIDENCE_TAIL), max_tokens=450)
                    evidence, missing = parse_evidence(raw)
                    if evidence:
                        note, draft = evidence_note(evidence, missing), evidence
                except Exception as exc:  # noqa: BLE001 — без опоры отвечаем как обычно
                    print(f"[consultant] опора из базы: {type(exc).__name__}: {exc}", file=sys.stderr)
            elif self.check_kb and premium:
                try:
                    check = build_messages(self.reference_text, materials, turns, mode, self.use_examples, exclude,
                                           style=self.style, task=CHECK_TAIL) if self.check_kb == 2 \
                        else build_check_messages(self.reference_text, materials, turns)
                    verdict = self.api.chat(check, max_tokens=160)
                    missing = parse_check(verdict)
                    if missing:
                        note, draft = CHECK_NOTE.format(missing=missing), f"нет в базе: {missing}"
                except Exception as exc:  # noqa: BLE001 — проверка не должна мешать ответу
                    print(f"[consultant] проверка базы: {type(exc).__name__}: {exc}", file=sys.stderr)
            if not text:
                messages = build_messages(self.reference_text, materials, turns, mode, self.use_examples, exclude,
                                          plan=self.plan, style=self.style, near=self.near, note=note,
                                          brief_think=think and self.think_brief)
                text, error = self.generate(messages, think=think, attempts=1 if fast else 2, plan=self.plan)
        if error == "overflow":
            # Промпт не поместился в контекст модели — сокращаем материалы до одного документа.
            ranked, docs, extra = self.retrieve(turns, query_vec, fast=True, compact=True)
            materials = self.render_materials(docs, extra)
            messages = build_messages("", materials, turns, mode, self.use_examples, exclude)
            text, error = self.generate(messages, think=False, attempts=1)
        timings["generation"] = time.perf_counter() - t1
        guard = {}
        # Числа сверяем со всем, что видела модель: справочник, материалы, примеры, диалог.
        known = "\n".join([self.kb_text if messages and "БАЗА ЗНАНИЙ" in messages[0]["content"] else self.reference_text,
                           materials, render_examples() if self.use_examples else ""])
        if text and self.refine and not fast:
            t2 = time.perf_counter()
            try:
                better = tidy(split_plan(self.api.chat(messages + [{"role": "assistant", "content": text},
                                                                   {"role": "user", "content": REFINE}])))
                if better and word_count(better) >= 8:
                    guard["refined"] = better != text
                    text = better
            except Exception as exc:  # noqa: BLE001
                guard["refine_error"] = f"{type(exc).__name__}: {exc}"
            timings["refine"] = time.perf_counter() - t2
        if text:
            t3 = time.perf_counter()
            text, checked = self.check(text, messages, known, turns, fast)
            guard.update(checked)
            timings["guard"] = time.perf_counter() - t3
        timings["total"] = time.perf_counter() - t0
        if not text:
            reason = "ответ отброшен проверкой цифр" if guard.get("dropped") else (error or "пустой ответ")
            return Answer(extractive(top_chunks) or FALLBACK, sources, timings, reason, guard)
        return Answer(text, sources, timings, "", guard, draft)

    # ---------- схема factmap ----------
    def _exclude_example(self, turns: list) -> str:
        if not self.examples_loo:
            return ""
        return turns[0]["content"] if len(turns) == 1 else "\n".join(
            ("Пользователь: " if t["role"] == "user" else "Ассистент: ") + t["content"] for t in turns)

    def fm_search(self, turns: list, query_vec=None, fast: bool = False, guard: dict | None = None) -> list:
        """Разделы по вопросу: короткая реплика → самостоятельный вопрос, гибридный поиск, реранкер."""
        lexical, semantic, _last = search_queries(turns)
        char_query = semantic
        if self.fm_condense and not fast and self.api.configured and needs_condense(turns):
            try:
                condensed = clean_condensed(self.api.chat(build_condense_messages(turns), max_tokens=80,
                                                          temperature=0.0))
                if condensed:
                    lexical = f"{condensed} {condensed} {lexical}"
                    semantic = char_query = condensed
                    query_vec = None  # вектор считаем уже по переписанному вопросу
                    if guard is not None:
                        guard["condensed"] = condensed
            except Exception as exc:  # noqa: BLE001 — без переписывания ищем по диалогу как есть
                print(f"[consultant] переписывание реплики: {type(exc).__name__}: {exc}", file=sys.stderr)
        if query_vec is None and self.dense and not fast:
            query_vec = self.embed_queries([semantic])[0]
        hits = self.retriever.search(lexical, query_vec, rerank_query=semantic, n_candidates=self.fm_candidates,
                                     rerank=not fast, exclude=self.fm_ids, template=self.rerank_template,
                                     char_query=char_query)
        if self.fm_llm_rerank and not fast and hits:
            hits = self.llm_rerank(turns, hits, guard)
        top = [h.chunk for h in hits[: self.fm_top]]
        if self.fm_toc and not fast:
            picked = self.toc_select(turns, guard)
            seen = set()
            top = [c for c in picked + top if not (c.id in seen or seen.add(c.id))][: max(self.fm_top, len(picked))]
        return top

    def llm_rerank(self, turns: list, hits: list, guard: dict | None = None) -> list:
        """LLM-реранк (Райс): модель оценивает каждого кандидата 0–10, итог = 0,3 · скор поиска + 0,7 · оценка."""
        listing = "\n\n".join(f"[{i}] {h.chunk.doc} | {h.chunk.path}\n{h.chunk.text[:700]}" for i, h in enumerate(hits))
        messages = [{"role": "system", "content": LLM_RERANK_SYSTEM},
                    {"role": "user", "content": f"{render_dialog(turns)}\n\nРАЗДЕЛЫ\n{listing}"}]
        try:
            marks = parse_marks(self.api.chat(messages, max_tokens=400, temperature=0.0), len(hits))
        except Exception as exc:  # noqa: BLE001 — без реранка остаётся порядок поиска
            print(f"[consultant] LLM-реранк: {type(exc).__name__}: {exc}", file=sys.stderr)
            return hits
        if not marks:
            return hits
        top = max(h.score for h in hits) or 1.0
        scored = [(0.3 * h.score / top + 0.7 * marks.get(i, 0) / 10, h) for i, h in enumerate(hits)]
        scored.sort(key=lambda x: -x[0])
        if guard is not None:
            guard["llm_rerank"] = len(marks)
        return [h for _, h in scored]

    def toc_select(self, turns: list, guard: dict | None = None) -> list:
        """Отбор разделов по оглавлению базы (идея PageIndex): модель видит только заголовки."""
        pool = [c for c in self.kb.chunks if c.id not in self.fm_ids]
        toc = "\n".join(f"[{i}] {c.title} > {c.path}" for i, c in enumerate(pool))
        messages = [{"role": "system", "content": TOC_SYSTEM},
                    {"role": "user", "content": f"ОГЛАВЛЕНИЕ БАЗЫ\n{toc}\n\n{render_dialog(turns)}"}]
        try:
            raw = self.api.chat(messages, max_tokens=80, temperature=0.0)
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] оглавление: {type(exc).__name__}: {exc}", file=sys.stderr)
            return []
        numbers = list(dict.fromkeys(int(n) for n in re.findall(r"\d+", raw) if int(n) < len(pool)))[:6]
        if guard is not None:
            guard["toc"] = len(numbers)
        return [pool[n] for n in numbers]

    def fm_generate(self, messages: list) -> tuple:
        """Ответ без размышлений; пустой ответ — повтор с reasoning_effort=low и запасом токенов."""
        error = ""
        for attempt in range(2):
            try:
                text = tidy(self.api.chat(messages, max_tokens=self.fm_max_tokens, temperature=self.fm_temperature,
                                          extra=self.fm_sampling, retry_empty=False))
                if text:
                    return text, ""
                # Сервер проигнорировал отключение размышлений и ответ ушёл в них — даём модели подумать
                # коротко; <think>…</think> вырезается в strip_thinking.
                text = tidy(strip_thinking(self.api.chat(
                    messages, max_tokens=1500, temperature=self.fm_temperature,
                    extra={**self.fm_sampling, "reasoning_effort": "low"}, thinking_fields=False,
                    retry_empty=False)))
                if text:
                    return text, ""
                error = "пустой ответ модели"
            except Exception as exc:  # noqa: BLE001 — на выходе всегда должен быть ответ
                error = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] LLM, попытка {attempt + 1}: {error}", file=sys.stderr)
                if type(exc).__name__ == "DeadlineExceeded":
                    break
        return "", error

    def answer_factmap(self, turns: list, mode: str = "eval", query_vec=None, fast: bool = False,
                       offline: bool = False) -> Answer:
        """Запасная цепочка: нет реранкера → RRF; нет эмбеддингов → только лексика; поиск сломан → вся база
        в контексте; модель недоступна → выдержка из базы или безопасный шаблон."""
        timings, guard = {}, {}
        t0 = time.perf_counter()
        try:
            top = self.fm_search(turns, query_vec, fast=fast or offline, guard=guard)
            parents = list(dict.fromkeys(c.doc for c in top))[: self.fm_parent]
            blocks = [self.retriever.render_doc(d) for d in parents] + [c.render() for c in top if c.doc not in parents]
            if self.fm_reverse:
                # «Lost in the Middle» (Liu et al., TACL 2024): модель лучше использует текст в начале и в конце
                # контекста — самое релевантное ставим последним, вплотную к вопросу.
                blocks = blocks[::-1]
            materials = "\n\n".join(blocks)
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] поиск недоступен ({type(exc).__name__}: {exc}) — вся база в контексте",
                  file=sys.stderr)
            top, materials = [], self.kb_text
            guard["full_kb"] = True
        timings["retrieval"] = time.perf_counter() - t0
        sources = [(c.doc, c.path, None) for c in top]
        if offline:
            timings["total"] = time.perf_counter() - t0
            return Answer(extractive(top) or FALLBACK, sources, timings, "без модели: лимит времени", guard)
        t1 = time.perf_counter()
        if self.fm_prompt in ("v3", "jury"):
            messages = build_messages(self.fact_map, materials, turns, mode, self.use_examples,
                                      self._exclude_example(turns), style="jury" if self.fm_prompt == "jury" else "tight")
        else:
            messages = build_fm_messages(self.fact_map, materials, turns, mode, self.use_examples,
                                         self._exclude_example(turns))
        text, error = self.fm_generate(messages)
        timings["generation"] = time.perf_counter() - t1
        if text:
            # Число допустимо, только если оно есть в карте фактов, найденных разделах или репликах клиента.
            # Примеры эталонов сюда сознательно не входят: их числа относятся к другим вопросам.
            t2 = time.perf_counter()
            text, checked = self.check(text, messages, f"{self.fact_map}\n{materials}", turns, fast)
            guard.update(checked)
            timings["guard"] = time.perf_counter() - t2
        timings["total"] = time.perf_counter() - t0
        if not text:
            reason = "ответ отброшен проверкой цифр" if guard.get("dropped") else (error or "пустой ответ")
            return Answer(extractive(top) or FALLBACK, sources, timings, reason, guard)
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
                fixed = tidy(split_plan(self.api.chat(messages + [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": repair_instruction(bad, too_long)},
                ])))
                if fixed:
                    text, guard["repaired"] = fixed, True
            except Exception as exc:  # noqa: BLE001
                guard["repair_error"] = f"{type(exc).__name__}: {exc}"
        still_bad = unknown_numbers(text, materials, dialog)
        if still_bad:
            stripped = strip_sentences(text, still_bad)
            if word_count(stripped) >= 8:
                text, guard["stripped"] = stripped, still_bad
            else:
                # Без непроверенных чисел ответа почти не осталось — не отдаём выдумку,
                # вызывающий подставит выдержку из базы.
                text, guard["dropped"] = "", still_bad
        return text, guard
