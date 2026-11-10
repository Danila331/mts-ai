"""Сравнение multi-query и EB_QUERY_REWRITE на синтетических диалогах.

Это проверка поиска на ГОТОВЫХ переформулировках. Качество формирования
search_query самой LLM здесь не измеряется.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.dialog import parse  # noqa: E402
from energybot.llm import env  # noqa: E402
from energybot.pipeline import Consultant  # noqa: E402

CASES = [
    {
        "id": "losses-short-reference",
        "question": "Пользователь: Мы электросетевая компания, ищем коммерческие потери.\n"
                    "Ассистент: Какой архив данных есть?\nПользователь: Примерно за два года. Таких данных хватит?",
        "rewrite": "поиск коммерческих потерь, архив за два года, требования к глубине и детализации данных",
        "sources": {("20-products/24-losses.md", "Какой результат даёт продукт")},
    },
    {
        "id": "solar-evening",
        "question": "Пользователь: Хотим снизить расходы и иметь резерв, но основная нагрузка вечером.\n"
                    "Ассистент: Накопители рассматриваем отдельно.\n"
                    "Пользователь: А обычная сетевая станция вообще имеет смысл?",
        "rewrite": "сетевая солнечная станция без накопителей, вечернее потребление, снижение платежа",
        "sources": {("20-products/23-solar.md", "Два типа станций")},
    },
    {
        "id": "photo-year",
        "question": "Пользователь: Обсуждаем распознавание показаний по фотографии.\n"
                    "Ассистент: Сервис считывает показания, серийный номер и штрих-код.\n"
                    "Пользователь: А год выпуска счётчика прочитает?",
        "rewrite": "распознавание по фотографии, год производства прибора учёта",
        "sources": {("20-products/25-meter-reading.md", "Что распознаётся")},
    },
    {
        "id": "tariff-topic-switch",
        "question": "Пользователь: Расскажите про солнечные панели на кровле.\nАссистент: Уточню регион.\n"
                    "Пользователь: Кровля плоская.\nАссистент: Принял.\n"
                    "Пользователь: А теперь про тарифы: что выгоднее, третья или четвёртая категория?",
        "rewrite": "третья и четвёртая ценовые категории, почасовая цена, одноставочная и двухставочная передача",
        "sources": {("10-energy/11-price-categories.md", "Шесть категорий")},
    },
    {
        "id": "orem-threshold",
        "question": "Пользователь: У нас производство, хотим выйти на оптовый рынок.\n"
                    "Ассистент: Важна присоединённая мощность.\nПользователь: У нас 0,8 МВт. Мы проходим?",
        "rewrite": "выход на оптовый рынок, присоединённая мощность 0,8 МВт, порог доступа",
        "sources": {("20-products/21-orem.md", "Кому подходит > Порог доступа определяется присоединённой мощностью")},
    },
    {
        "id": "solar-installment",
        "question": "Пользователь: Стоимость проекта сразу велика для нас.\n"
                    "Ассистент: Есть разные механизмы оплаты.\nПользователь: Можно оплачивать станцию частями?",
        "rewrite": "солнечная станция, рассрочка до 5 лет, сезонный график платежей, поэтапный ввод",
        "sources": {("20-products/23-solar.md", "Механизмы оплаты")},
    },
    {
        "id": "ambiguous-two-products",
        "question": "Пользователь: Обсуждаем платформу учёта и солнечную станцию.\n"
                    "Ассистент: Можно сравнить оба направления.\nПользователь: Сколько это стоит?",
        "rewrite": "",  # предмет нельзя выбрать за клиента: текущий путь поиска сохраняется
        "sources": {("20-products/22-askue.md", "Частые вопросы > Сколько это стоит")},
    },
]


def evaluate(bot, rewrite_enabled: bool) -> list:
    os.environ["EB_QUERY_REWRITE"] = "1" if rewrite_enabled else "0"
    rows = []
    for case in CASES:
        started = time.perf_counter()
        hits, chunks = bot.retrieve(parse(case["question"]), state={"search_query": case["rewrite"]})
        elapsed = time.perf_counter() - started
        expected = case["sources"]
        candidate_have = {(hit.chunk.doc, hit.chunk.path) for hit in hits}
        context_have = {(chunk.doc, chunk.path) for chunk in chunks}
        candidate_part = len(expected & candidate_have) / len(expected)
        context_part = len(expected & context_have) / len(expected)
        rows.append({"id": case["id"],
                     "candidate_full": expected <= candidate_have, "candidate_part": candidate_part,
                     "context_full": expected <= context_have, "context_part": context_part,
                     "seconds": elapsed})
    return rows


def main():
    bot = Consultant(ROOT / "knowledge-base", index_dir=ROOT / "index")
    old = evaluate(bot, False)
    new = evaluate(bot, True)
    result = {"mode": "hybrid" if bot.dense else "BM25", "reranker": env("EB_USE_RERANKER", "1") != "0",
              "note": "Проверка поиска на готовых переформулировках; качество LLM-переписчика не измерено.",
              "old": old, "new": new}
    print(result["note"])
    print(f"Режим: {result['mode']}; reranker: {result['reranker']}")
    print("| кейс | кандидаты старый/новый | контекст старый/новый | full старый/новый | сек старый/новый |")
    print("|---|---:|---:|---|---|")
    for before, after in zip(old, new):
        print(f"| {before['id']} | {before['candidate_part']:.2f}/{after['candidate_part']:.2f} | "
              f"{before['context_part']:.2f}/{after['context_part']:.2f} | "
              f"{before['context_full']}/{after['context_full']} | {before['seconds']:.2f}/{after['seconds']:.2f} |")
    for name, rows in (("старый", old), ("новый", new)):
        print(f"{name}: кандидаты full {sum(r['candidate_full'] for r in rows)}/{len(rows)}, "
              f"контекст full {sum(r['context_full'] for r in rows)}/{len(rows)}, "
              f"средняя доля контекста {statistics.mean(r['context_part'] for r in rows):.2f}, "
              f"средняя задержка {statistics.mean(r['seconds'] for r in rows):.2f} с")
    out = ROOT / "eval" / "reports" / f"query-rewrite-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Отчёт: {out}")


if __name__ == "__main__":
    main()
