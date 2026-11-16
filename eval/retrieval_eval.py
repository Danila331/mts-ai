"""Качество поиска на демо-вопросах: находится ли нужный документ базы.

Работает без API (только BM25). С ключами в окружении добавляет bge-m3 и реранкер.
Эталонные документы: eval/gold_demo.json для демо и sources кейсов выборки
(первый источник считается главным).

    python eval/retrieval_eval.py [--split dev|holdout|all] [--k 6] [--verbose]
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.dialog import parse  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402


def retrieved_context(bot, result) -> tuple:
    """(выдача, разделы, которые видит модель) для любой версии Consultant.retrieve.

    Старые версии возвращают (выдача, контекст), схема v3 — (выдача, документы целиком, фрагменты);
    во втором случае контекст — разделы документов целиком, фрагменты и справочник в неизменной части
    промпта (если он включён), как в scripts/core_api.py (WebConsultant.context_chunks).
    """
    if len(result) == 2:
        return result
    hits, docs, extra = result
    context = [c for c in bot.kb.chunks if c.doc in docs] + list(extra)
    if getattr(bot, "reference_text", ""):
        context += bot.retriever.reference()
    return hits, list({c.id: c for c in context}.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", default=str(ROOT / "demo_questions.csv"))
    ap.add_argument("--gold", default=str(ROOT / "eval" / "gold_demo.json"))
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "dataset" / "cases.jsonl"))
    ap.add_argument("--split", default="dev", choices=["dev", "holdout", "all"])
    ap.add_argument("--kb", default=str(ROOT / "knowledge-base"))
    ap.add_argument("--k", type=int, default=0, help="переопределить EB_TOP_K")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    gold = {k: v for k, v in json.loads(Path(args.gold).read_text(encoding="utf-8")).items() if not k.startswith("_")}
    with open(args.questions, encoding="utf-8-sig", newline="") as f:
        questions = {r["id"].strip(): r["question"] for r in csv.DictReader(f)}
    items = [(qid, questions[qid], docs) for qid, docs in gold.items()]
    sections = {}  # разделы-источники эталона: есть только у кейсов выборки
    if args.dataset and Path(args.dataset).is_file():
        # Для вопросов вне базы искать нечего: общие границы и так всегда в контексте.
        skip = {"out-of-kb", "out-of-scope", "adversarial"}
        for line in Path(args.dataset).read_text(encoding="utf-8").splitlines():
            c = json.loads(line)
            if c["category"] in skip or (args.split != "all" and c.get("split") != args.split):
                continue
            docs = list(dict.fromkeys(Path(s["doc"]).name for s in c["sources"]))
            if docs:
                items.append((c["id"], c["question"], docs))
                sections[c["id"]] = {(s["doc"], s["section"]) for s in c["sources"]}

    bot = Consultant(Path(args.kb), index_dir=ROOT / "index")
    if args.k:
        bot.top_k = args.k
    hit1 = hitk = cover = mrr = 0.0
    sec_full = sec_part = 0.0
    sizes = []
    misses = []
    for qid, question, docs in items:
        hits, context = retrieved_context(bot, bot.retrieve(parse(question)))
        found = [Path(h.chunk.doc).name for h in hits]
        ctx_docs = {Path(c.doc).name for c in context}
        main_doc = docs[0]
        hit1 += found[:1] == [main_doc]
        hitk += main_doc in found
        cover += len(set(docs) & ctx_docs) / len(docs)
        sizes.append(sum(len(c.render()) for c in context))
        if qid in sections:
            have = {(c.doc, c.path) for c in context}
            sec_full += sections[qid] <= have
            sec_part += len(sections[qid] & have) / len(sections[qid])
        rank = next((i for i, d in enumerate(found) if d in docs), None)
        mrr += 0 if rank is None else 1 / (rank + 1)
        if main_doc not in found:
            misses.append(qid)
        if args.verbose:
            mark = "OK " if main_doc in found else "MISS"
            print(f"{mark} [{qid}] нужен {docs} → {[f'{h.chunk.doc.split(chr(47))[-1]}|{h.chunk.path[:35]}' for h in hits]}")
    n = len(items)
    print(f"\nрежим: {'гибрид' if bot.dense else 'BM25'}{' + реранкер' if bot.api.configured and bot.api.can_rerank else ''}; "
          f"k={bot.top_k}, документов целиком={getattr(bot, 'full_docs', getattr(bot, 'expand_docs', '?'))}, бюджет={bot.context_chars}; вопросов: {n}")
    print(f"hit@1 (главный документ первым): {hit1 / n:.2f}")
    print(f"hit@{bot.top_k} (главный документ в выдаче): {hitk / n:.2f}")
    print(f"покрытие всех нужных документов в контексте: {cover / n:.2f}")
    print(f"MRR: {mrr / n:.2f}")
    if sections:
        m = len(sections)
        print(f"разделы-источники эталона (кейсов {m}): все в контексте {sec_full / m:.2f}, "
              f"доля найденных {sec_part / m:.2f}  ← главная метрика для ответа")
    print(f"контекст, символов: медиана {statistics.median(sizes):.0f}, макс {max(sizes)}")
    if misses:
        print(f"промахи ({len(misses)}): {misses[:40]}{' …' if len(misses) > 40 else ''}")


if __name__ == "__main__":
    main()
