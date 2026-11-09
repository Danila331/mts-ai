"""Предрасчёт эмбеддингов bge-m3 для фрагментов базы → index/ (кладётся в ZIP сабмита).

На платформе индекс подхватывается по id фрагментов; если база изменилась,
недостающие фрагменты досчитываются на лету.

    python scripts/build_index.py   # нужны LLM_BASE_URL и LLM_API_KEY (или EMBEDDER_*)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from energybot.kb import KnowledgeBase  # noqa: E402
from energybot.llm import Api  # noqa: E402
from energybot.retrieval import Retriever  # noqa: E402


def main():
    api = Api()
    if not (api.emb_url and api.emb_key):
        sys.exit("Задайте LLM_BASE_URL и LLM_API_KEY (или EB_EMBEDDER_BASE_URL/EMBEDDER_API_KEY)")
    kb = KnowledgeBase.load(ROOT / "knowledge-base")
    retriever = Retriever(kb, api, index_dir=None, dense=True)
    if retriever.vectors is None:
        sys.exit("Не удалось получить эмбеддинги — индекс не сохранён")
    retriever.save_index(ROOT / "index")
    print(f"index/: {len(kb.chunks)} фрагментов, размерность {retriever.vectors.shape[1]}, "
          f"база {kb.fingerprint}, модель {api.emb_model}")


if __name__ == "__main__":
    main()
