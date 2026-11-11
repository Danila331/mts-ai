"""Конвейер ответа: разбор входа → поиск → промпт → LLM → постобработка."""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from .ambiguity import AmbiguityClassifier, decision_note
from .calc import calculate, extract_parameters, infer_operation
from .dialog import parse, search_queries
from .gold_examples import GoldenExamples
from .slots import choose_question, product_from_dialog, product_of
from .guard import MAX_WORDS, SENTENCE, repair_instruction, strip_sentences, unknown_numbers, word_count
from .kb import KnowledgeBase
from .llm import Api, env, env_num
from .prompts import build_draft_messages, build_write_messages, filter_examples, system_prompt
from .retrieval import Retriever

FALLBACK = (
    "Точного ответа на этот вопрос в моих материалах нет, поэтому не буду гадать. "
    "Его лучше уточнить у специалиста МТС EnergyTool — он разберёт вашу ситуацию предметно."
)

VERIFY_INSTRUCTION = """[Служебная проверка.] Выше — мой черновик ответа клиенту{second}.
Проверь его по МАТЕРИАЛАМ и правилам:
1. Каждое число и факт в ответе должны быть из МАТЕРИАЛОВ, с их оговорками; термины — дословно из МАТЕРИАЛОВ.
2. Ответ должен прямо отвечать на ПОСЛЕДНЮЮ реплику клиента; если в ней несколько вопросов — закрыть все.
3. Полнота: если в МАТЕРИАЛАХ есть важная оговорка или ограничение по теме вопроса, а ответ её упустил — добавь. Второстепенные факты не добавляй.
4. Тональность — как в МАТЕРИАЛАХ: не категоричнее и не мягче.
5. 25–40 слов, обычный текст; уточняющий вопрос в конце — только если для следующего шага нужны данные клиента.
Выбери более точный черновик или объедини их, исправь найденные ошибки и выведи только итоговый ответ клиенту, без пояснений.

Черновик А:
{draft_a}{draft_b_block}"""

FACTS_INSTRUCTION = """[Служебное.] Не отвечая клиенту, выпиши из раздела МАТЕРИАЛЫ 3–5 самых важных для ответа на последнюю реплику фактов, цифр и оговорок — дословно или близко к тексту. Каждый факт с новой строки, начиная с «- «. Только факты из материалов, ничего от себя."""


@dataclass
class Answer:
    text: str
    sources: list = field(default_factory=list)  # [(doc, path, score)]
    timings: dict = field(default_factory=dict)
    error: str = ""
    guard: dict = field(default_factory=dict)  # что сработало в проверке ответа (для отладки)
    used_sources: list = field(default_factory=list)  # источники, чьи числа реально вошли в ответ
    draft: str = ""
    write: str = ""


def used_sources(sources: list, chunks: list, answer: str) -> list:
    """Источники, реально использованные в ответе: числа раздела встречаются в тексте ответа
    либо совпадает заголовок раздела. Проверяемо, в отличие от «модель сказала источник»."""
    from .guard import numbers
    ans_nums = numbers(answer)
    used = []
    for c in chunks:
        shared = ans_nums & numbers(c.text)
        if shared or (c.path and c.path.split(">")[0].strip().lower() in answer.lower()):
            used.append((c.doc, c.path, sorted(shared)))
    source_ids = {(d, p) for d, p, _ in sources}
    return [u for u in used if (u[0], u[1]) in source_ids]


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


# Типизированные смысловые ребра поверх редакционных links (docs/kb-graph.md):
# (текущий продукт, документ-цель, раздел цели, регекс активации в диалоге).
EXTRA_EDGES = [
    # solar: ветвление сетевая/гибридная внутри 23-solar — при «отключениях/резерве»
    ("solar", "20-products/23-solar.md", "Два типа станций", r"отключен|резерв|автономн|перебо|вечер"),
    # solar → microgeneration: продажа излишков — отдельный режим с жёсткой оговоркой
    ("solar", "10-energy/15-microgeneration.md", "Сколько можно отдавать в сеть", r"излишк|отдава|отдать|продав|выкуп"),
    # orem → askue: коммерческий учёт — предусловие выхода на опт (всегда по теме)
    ("orem", "20-products/22-askue.md", "Что это", r"опт|750|выход"),
    # orem → metering: «уже стоят свои счётчики» — виды учёта и что менять не надо
    ("orem", "10-energy/13-metering.md", "Виды учёта", r"сч[её]тчик|прибор"),
    # tariff → askue: категории 3–6 требуют интервальный учёт
    ("tariff", "20-products/22-askue.md", "Что это", r"категори"),
    # tariff → thresholds: «обязаны уйти из 1–2 категории» — порог 670 кВт
    ("tariff", "10-energy/12-power-thresholds.md", "Порог 670 кВт", r"обязан|обяжут|переведут|заставят"),
    # askue → metering: минимальный состав функций ИСУ (норматив)
    ("askue", "10-energy/13-metering.md", "Интеллектуальные системы учёта", r"функци|минимум|интеллектуальн"),
    # solar ⇄ tariff: альтернатива снижения платежа, когда опт недоступен
    ("solar", "10-energy/11-price-categories.md", "Что такое ценовая категория", r"опт|750|плат[её]ж|сниз"),
]


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
        self.context_chars = env_num("EB_CONTEXT_CHARS", 10000, 2000, 60000)
        # Динамический few-shot: ближайшие эталоны жюри по эмбеддингу вопроса.
        self.golden = None
        if env("EB_DYNAMIC_FEWSHOT", "1") != "0" and self.api.configured:
            self.golden = GoldenExamples(self.api)
            if self.golden.vecs is None:
                self.golden = None
        self.ambiguity = AmbiguityClassifier(self.api)
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
        self._last_qvec = query_vec  # для динамического few-shot
        ranked = self.retriever.search(lexical, query_vec, rerank_query=semantic, n_candidates=self.n_candidates,
                                       rerank=not fast)
        # CRAG PARTIAL: после реранкера выбрасываем INCORRECT-чанки (скор ниже порога)
        # из контекста всегда — мусор в контексте становится выдумкой в ответе.
        if not fast:
            min_chunk = env_num("EB_CHUNK_MIN", 0.05, 0.0, 1.0, float)
            filtered = [h for h in ranked if float(h.score) >= min_chunk]
            if filtered:
                ranked = filtered
        context = self.retriever.context(ranked, top_k=self.top_k, expand_docs=self.expand_docs,
                                         char_budget=self.context_chars,
                                         ref_query=lexical if env("EB_REF_MIX", "1") != "0" else "")
        context = self._close_graph(context, turns)
        return ranked[: self.top_k], context

    def _close_graph(self, context: list, turns: list) -> list:
        """Замыкание графа документов базы: к топ-продукту добавляем ключевой раздел
        связанного продукта, если его ветка активна в диалоге (demo-15: платформа + фото).
        Ребра редакционные (kb links), активация — по ключевым словам ветки."""
        import re as _re
        from .slots import DIALOG_PRODUCT, PRODUCT_BY_DOC, product_of
        seen = {c.id for c in context}
        product_docs = [c.doc for c in context if c.doc.startswith("20-products/")]
        dialog = "\n".join(t["content"] for t in turns)
        added = 0
        if product_docs:
            # Граф по ссылкам разделов (двусторонний).
            graph = {}
            for c in self.kb.chunks:
                graph.setdefault(c.doc, set()).update(c.links)
                for l in c.links:
                    graph.setdefault(l, set()).add(c.doc)
            # Ключевые слова продукта из DIALOG_PRODUCT (порядок слотов в slots.py).
            pat_by_product = dict(DIALOG_PRODUCT)
            doc_product = {f"20-products/{name}": p for name, p in PRODUCT_BY_DOC.items()}
            for doc in dict.fromkeys(product_docs):
                for linked in graph.get(doc, ()):
                    if added >= 2:
                        break
                    linked_full = linked if "/" in linked else f"20-products/{linked}"
                    lprod = doc_product.get(linked_full, "")
                    pat = pat_by_product.get(lprod)
                    if not pat or not _re.search(pat, dialog, _re.I):
                        continue  # ветка не активна в диалоге
                    key = next((c for c in self.kb.chunks
                                if c.doc == linked_full and c.path in ("Что это", "Какую задачу закрывает")), None)
                    if key and key.id not in seen:
                        context.append(key)
                        seen.add(key.id)
                        added += 1
        # Типизированные смысловые ребра (ветвление/предусловие/альтернатива) — docs/kb-graph.md.
        # Работают и без продуктового документа в контексте: тарифные вопросы живут в 10-energy.
        product_now = product_from_dialog(dialog) or product_of([c.doc for c in context])
        for src, target_doc, target_path, pattern in EXTRA_EDGES:
            if added >= 2:
                break
            if src != product_now or not _re.search(pattern, dialog, _re.I):
                continue
            key = next((c for c in self.kb.chunks
                        if c.doc == target_doc and target_path.split(">")[0].strip() in c.path), None)
            if key and key.id not in seen:
                context.append(key)
                seen.add(key.id)
                added += 1
        return context

    def answer(self, question, mode: str = "eval", query_vec=None, fast: bool = False,
               offline: bool = False) -> Answer:
        """fast — без реранкера и без повторной генерации (нехватка времени);
        offline — без модели вообще (время вышло): выдержка из базы."""
        timings = {}
        t0 = time.perf_counter()
        turns = parse(question) if isinstance(question, str) else question
        hits, chunks = self.retrieve(turns, query_vec, fast=fast or offline)
        timings["retrieval"] = time.perf_counter() - t0
        # Порог релевантности + корректирующий повтор (CRAG-lite): «лучше ноль чанков,
        # чем слабые». Если топ ниже порога — один перезапрос с переформулировкой;
        # всё ещё слабо — честная граница без генерации из мусора.
        min_score = env_num("EB_MIN_SCORE", 0.01, 0.0, 1.0, float)
        if not fast and not offline and hits and float(hits[0].score) < min_score:
            hits2, chunks2 = self.corrective_retry(turns)
            if hits2 and float(hits2[0].score) >= min_score:
                hits, chunks = hits2, chunks2
            else:
                timings["total"] = time.perf_counter() - t0
                return Answer(FALLBACK, [], timings, "")
        # Эксперимент 3: LLM-отбор фрагментов перед генерацией (EB_LLM_SELECT=1).
        if not fast and not offline and env("EB_LLM_SELECT") == "1":
            chunks = self.select_chunks(chunks, turns)
        sources = [(h.chunk.doc, h.chunk.path, round(float(h.score), 4)) for h in hits]
        sources += [(c.doc, c.path, None) for c in chunks[len(hits):]]
        materials = "\n\n".join(c.render() for c in chunks)
        # Детерминированный калькулятор: распознанные расчёты идут мимо LLM-арифметики.
        calc_note = ""
        if env("EB_CALC", "1") != "0":
            calc_note = self.try_calc(turns)
            if calc_note:
                materials = calc_note + "\n\n" + materials
        # Эксперимент 2: реранкер по предложениям топ-чанков (EB_SENT_RERANK=1).
        if not fast and not offline and env("EB_SENT_RERANK") == "1":
            materials = self.add_key_sentences(materials, chunks, turns)
        if offline:
            timings["total"] = time.perf_counter() - t0
            text_off = extractive(chunks) or FALLBACK
            return Answer(text_off, sources, timings, "без модели: лимит времени")
        # Классификатор неоднозначности: что известно, чего нет, какой вопрос задать.
        note = ""
        if not fast and env("EB_AMBIGUITY", "0") != "0":
            note = decision_note(self.ambiguity.classify(turns, materials, fast=fast))
        # Интент последней реплики → обязательная открывашка и правило вопроса (типы А–К).
        dialog_text = "\n".join(t["content"] for t in turns)
        last_user = next((t["content"] for t in reversed(turns) if t["role"] == "user"), "")
        _, _, intent_ask = ("", "", None)
        if env("EB_INTENT", "1") != "0":
            from .intent import classify_intent, intent_note
            _, _, intent_ask = classify_intent(last_user)
            inote = intent_note(last_user)
            if inote:
                note = inote
        if env("EB_SLOTS", "1") != "0":
            # Детерминированная очередь слотов продукта: вопрос из базы, не из головы.
            product = product_from_dialog(dialog_text) or product_of([h.chunk.doc for h in hits])
            question = choose_question(product, dialog_text, last_user)
            if question and intent_ask is not False:
                note = (note + " " if note else "") + (
                    "ОБЯЗАТЕЛЬНО закончи ответ уточняющим вопросом именно на эту тему "
                    f"(своими словами): «{question}». Даже если примеры выше заканчиваются "
                    "другим вопросом — тема важнее примера.")
            elif product and intent_ask is not False:
                note = (note + " " if note else "") + (
                    "КАТЕГОРИЧЕСКИ не задавай уточняющий вопрос в конце: ответ закрыт "
                    "или спрашивать нечего. Закончи утверждением.")
        prompt_text = system_prompt(materials, mode, examples="")  # примеры — сообщениями ниже
        if note:
            prompt_text += "\n\nРЕШЕНИЕ ПО ЭТОМУ ХОДУ\n" + note
        messages = [{"role": "system", "content": prompt_text}]
        # Few-shot примеры как user/assistant-пары (LangChain: сообщения > строка в system).
        for q, a in self._example_pairs(mode, turns):
            messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
        messages += turns
        t1 = time.perf_counter()
        text, error, draft, written = "", "", "", ""
        if not fast and env("EB_TWO_STAGE", "1") != "0":
            try:
                draft_chunks = self._close_graph([h.chunk for h in hits], turns)
                draft_materials = "\n\n".join(c.render() for c in draft_chunks)
                if calc_note:
                    draft_materials = calc_note + "\n\n" + draft_materials
                draft = self.api.chat(build_draft_messages(draft_materials, turns)).strip()
            except Exception as exc:  # noqa: BLE001 — используем одностадийный путь
                print(f"[consultant] черновик недоступен: {type(exc).__name__}", file=sys.stderr)
            if draft:
                write_messages = build_write_messages(materials, turns, draft, mode, note=note)
                try:
                    written = tidy(self.api.chat(write_messages))
                except Exception as exc:  # noqa: BLE001 — используем одностадийный путь
                    print(f"[consultant] оформление недоступно: {type(exc).__name__}", file=sys.stderr)
                if written:
                    messages = write_messages
                    text = written
        if not text and not fast and env("EB_TWO_STAGE", "1") == "0" and env("EB_FACTS_COMPOSE") == "1":
            # Эксперимент 4: ответ собирается из извлечённых фактов, без полного контекста.
            text, error = self.compose_from_facts(turns, mode, materials)
        for attempt in range(1 if fast else 2):
            if text:
                break
            try:
                text = tidy(self.api.chat(messages))
                if text:
                    break
                error = "пустой ответ модели"
            except Exception as exc:  # noqa: BLE001 — на выходе всегда должен быть ответ
                error = f"{type(exc).__name__}: {exc}"
                print(f"[consultant] LLM, попытка {attempt + 1}: {error}", file=sys.stderr)
        # Второй проход ТОЛЬКО по сигналу (Future AGI: рефлексия на всём трафике не окупается):
        # слабый ретрив, обрезанный/длинный ответ, подозрительные числа — иначе пропускаем.
        if text and not fast and env("EB_VERIFY", "1") != "0":
            dialog = "\n".join(t["content"] for t in turns)
            weak = bool(hits) and float(hits[0].score) < env_num("EB_VERIFY_SCORE", 0.5, 0.0, 1.0, float)
            not_direct = self._expects_direct(turns) and not re.match(
                r"^(да|нет|можно|нельзя|пока нет|начать|начни|конечно|не совсем|не обязательно)\b",
                text.lower())
            suspect = bool(unknown_numbers(text, materials, dialog)) or word_count(text) > MAX_WORDS \
                or not_direct
            if weak or suspect:
                text = self.verify(messages, text, ensemble=env("EB_ENSEMBLE", "1") != "0")
        timings["generation"] = time.perf_counter() - t1
        guard = {}
        if text:
            t2 = time.perf_counter()
            text, guard = self.check(text, messages, materials, turns, fast)
            timings["guard"] = time.perf_counter() - t2
        timings["total"] = time.perf_counter() - t0
        if not text:
            fallback = extractive(chunks) or FALLBACK
            err = error or "пустой ответ"
            return Answer(fallback, sources, timings, err, guard, draft=draft, write=written)
        return Answer(text, sources, timings, "", guard, used_sources(sources, chunks, text), draft, written)

    def try_calc(self, turns: list) -> str:
        """Детерминированный расчёт (calc.py): если вопрос распознан как операция,
        считает без LLM и возвращает блок для контекста. Ноль — значит не наш случай."""
        dialog = "\n".join(t["content"] for t in turns)
        op = infer_operation(dialog)
        if not op:
            return ""
        result = calculate({"operation": op, "parameters": extract_parameters(op, dialog)})
        status = result.get("status")
        if status == "ok":
            return ("ДЕТЕРМИНИРОВАННЫЙ РАСЧЁТ (посчитано инструментом, не моделью; "
                    "используй дословно, ничего не пересчитывай):\n" + result["formatted"])
        if status == "needs_input":
            return ("ДЛЯ РАСЧЁТА НЕ ХВАТАЕТ (спроси это в уточняющем вопросе, "
                    "сам не додумывай): " + "; ".join(result.get("questions", [])))
        return ""  # invalid/unsupported — обычный ответ по материалам

    def _example_pairs(self, mode: str, turns: list) -> list:
        """Пары few-shot: ближайшие эталоны жюри, фолбэк — статические. В eval пропускаем
        самосовпадение (локально вопрос совпадает с эталонным, на платформе вопросы скрытые)."""
        from .prompts import static_example_pairs
        if self.golden is None:
            return filter_examples(static_example_pairs(), turns)
        pairs = self.golden.pick_pairs(getattr(self, "_last_qvec", None), skip_self=True)
        return filter_examples(pairs or static_example_pairs(), turns)

    def select_chunks(self, chunks: list, turns: list) -> list:
        """Эксперимент 3: LLM выбирает, какие фрагменты нужны для ответа. Сбой → все."""
        from .dialog import search_queries
        last = search_queries(turns)[2]
        listing = "\n".join(f"{i + 1}. {c.doc.split('/')[-1]} · {c.path}: {c.text[:150]}" for i, c in enumerate(chunks))
        try:
            out = self.api.chat([
                {"role": "system", "content": "Ты отбираешь фрагменты базы знаний для ответа на вопрос."},
                {"role": "user", "content": f"Вопрос клиента: {last}\n\nФрагменты:\n{listing}\n\n"
                                            "Верни только номера нужных фрагментов через запятую (1–5 штук)."},
            ], max_tokens=100)
            picked = [int(x) for x in re.findall(r"\d+", out)]
            chosen = [chunks[i - 1] for i in picked if 1 <= i <= len(chunks)]
            if chosen:
                return chosen
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] LLM-отбор фрагментов не удался: {exc}", file=sys.stderr)
        return chunks

    def add_key_sentences(self, materials: str, chunks: list, turns: list) -> str:
        """Эксперимент 2: реранкер по предложениям — в начало материалов добавляются
        5 предложений, самых релевантных вопросу. Сбой → материалы как были."""
        from .dialog import search_queries
        from .guard import SENTENCE
        sents = []
        for c in chunks[:5]:
            for s in SENTENCE.split(" ".join(c.text.split())):
                s = s.strip("- ").strip()
                if len(s) > 30:
                    sents.append(s)
        if not sents or not self.api.configured or not self.api.can_rerank:
            return materials
        try:
            scores = self.api.rerank(search_queries(turns)[1], sents[:40])
            top = sorted(zip(scores, sents), key=lambda x: -x[0])[:5]
            block = "\n".join(f"- {s}" for _, s in top)
            return f"КЛЮЧЕВЫЕ ПРЕДЛОЖЕНИЯ (самое важное по вопросу):\n{block}\n\nПОЛНЫЕ РАЗДЕЛЫ:\n{materials}"
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] реранк предложений не удался: {exc}", file=sys.stderr)
            return materials

    def compose_from_facts(self, turns: list, mode: str, materials: str) -> tuple:
        """Эксперимент 4: сначала извлечение фактов из материалов, затем ответ ТОЛЬКО из них."""
        try:
            facts = tidy(self.api.chat(
                [{"role": "system", "content": system_prompt(materials, mode)}] + turns +
                [{"role": "user", "content": FACTS_INSTRUCTION}], max_tokens=400))
            if not facts:
                return "", "пустое извлечение фактов"
            gen_messages = [{"role": "system", "content": system_prompt(
                f"КЛЮЧЕВЫЕ ФАКТЫ (единственный источник ответа):\n{facts}", mode)}] + turns
            return tidy(self.api.chat(gen_messages)), ""
        except Exception as exc:  # noqa: BLE001
            return "", f"{type(exc).__name__}: {exc}"

    def corrective_retry(self, turns: list):
        """Одна переформулировка запроса и повторный поиск (при слабом ретриве)."""
        from .dialog import search_queries
        last = search_queries(turns)[2]
        try:
            rewritten = tidy(self.api.chat([
                {"role": "system", "content": "Переформулируй запрос клиента для поиска по базе знаний "
                                              "энергетических продуктов: коротко, терминами, без ответа."},
                {"role": "user", "content": last},
            ], max_tokens=150))
            if not rewritten or rewritten.lower() == last.lower():
                return [], []
            print(f"[retrieval] корректирующий перезапрос: {rewritten[:80]}", file=sys.stderr)
            return self.retrieve([{"role": "user", "content": rewritten}], fast=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[retrieval] перезапрос не удался: {exc}", file=sys.stderr)
            return [], []

    def verify(self, messages: list, draft_a: str, ensemble: bool = True) -> str:
        """Второй проход: при наличии времени — второй черновик при другой температуре,
        затем один вызов, который сверяет черновики с материалами и выдаёт итог.
        Любой сбой — возвращаем исходный черновик."""
        draft_b = ""
        if ensemble:
            try:
                draft_b = tidy(self.api.chat(messages, temperature=0.5))
            except Exception:  # noqa: BLE001
                draft_b = ""
        try:
            instruction = VERIFY_INSTRUCTION.format(
                second=" и второй черновик" if draft_b else "",
                draft_a=draft_a,
                draft_b_block=f"\n\nЧерновик Б:\n{draft_b}" if draft_b else "")
            checked = tidy(self.api.chat(messages + [
                {"role": "assistant", "content": draft_a},
                {"role": "user", "content": instruction},
            ]))
            # Формат «ВЫБОР: … / ОТВЕТ: …» — берём только итоговый ответ.
            if "ОТВЕТ:" in checked:
                checked = checked.split("ОТВЕТ:", 1)[1].strip()
            else:
                checked = re.sub(r"^ВЫБОР:.*?(\n|$)", "", checked).strip()
            return checked or draft_a
        except Exception as exc:  # noqa: BLE001
            print(f"[consultant] самопроверка не удалась: {exc}", file=sys.stderr)
            return draft_a

    def check(self, text: str, messages: list, materials: str, turns: list, fast: bool) -> tuple:
        """Числа — только из материалов и диалога, длина — в разумных пределах,
        на вопрос «да/нет» — прямой ответ первым словом (скелет эталона жюри)."""
        dialog = "\n".join(t["content"] for t in turns)
        bad = unknown_numbers(text, materials, dialog)
        too_long = word_count(text) > MAX_WORDS
        not_direct = self._expects_direct(turns) and not re.match(
            r"^(да|нет|можно|нельзя|пока нет|начать|начни|конечно|не совсем|не обязательно)\b",
            text.lower())
        if not bad and not too_long and not not_direct:
            return text, {}
        guard = {"unknown_numbers": bad, "too_long": too_long, "not_direct": not_direct}
        if not fast:
            try:
                fixed = tidy(self.api.chat(messages + [
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": repair_instruction(bad, too_long, not_direct)},
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

    @staticmethod
    def _expects_direct(turns: list) -> bool:
        """Последняя реплика — вопрос, предполагающий «да/нет»."""
        last = next((t["content"] for t in reversed(turns) if t["role"] == "user"), "")
        return bool(re.search(r"(можно|стоит ли|подойд|подходит|подходим|выгодн|хватит|есть ли|сможете|"
                              r"предлагаете|разбер[её]т|проверите|переносится|работает|\bли\b)", last.lower()))
