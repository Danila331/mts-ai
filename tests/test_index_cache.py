"""Кеш векторов базы для ядра стенда (scripts/index_cache.py).

    python -m unittest tests.test_index_cache -v
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "scripts"))

import index_cache  # noqa: E402
from mock_api import MockApi  # noqa: E402

from energybot.kb import KnowledgeBase  # noqa: E402

KB_DIR = ROOT / "knowledge-base"


class _Env:
    def __init__(self, **values):
        self.values = values
        self.old = {}

    def __enter__(self):
        for k, v in self.values.items():
            self.old[k] = os.environ.get(k)
            os.environ[k] = v

    def __exit__(self, *exc):
        for k, v in self.old.items():
            os.environ.pop(k) if v is None else os.environ.__setitem__(k, v)


class IndexCacheTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def build(self, mock):
        """Старт ядра: ключ кеша → Consultant → запись кеша. Возвращает (каталог, бот)."""
        from energybot.llm import Api
        from energybot.pipeline import Consultant
        with _Env(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key"):
            api = Api()
            target = index_cache.index_dir(self.root, KnowledgeBase.load(KB_DIR), api)
            bot = Consultant(KB_DIR, index_dir=target, api=api)
            index_cache.save(bot.retriever, target)
        return target, bot

    def test_second_start_reads_cache(self):
        with MockApi(reject_template_kwargs=False) as mock:
            first, bot = self.build(mock)
            cold = mock.calls["embeddings"]
            self.assertTrue(bot.dense)
            self.assertTrue(index_cache.cached(first))

            second, bot2 = self.build(mock)
            warm = mock.calls["embeddings"] - cold
        self.assertEqual(first, second)
        self.assertEqual(warm, 1, "второй старт — только запрос отпечатка модели")
        self.assertGreater(cold, warm)
        # Загрузчик ядра нормирует векторы ещё раз — расхождение в последних знаках float32.
        import numpy as np
        self.assertTrue(np.allclose(bot.retriever.vectors, bot2.retriever.vectors, atol=1e-6))

    def test_key_changes_with_model_and_text(self):
        with MockApi(reject_template_kwargs=False) as mock:
            from energybot.llm import Api
            with _Env(LLM_BASE_URL=mock.url, LLM_API_KEY="test-key"):
                api = Api()
                kb = KnowledgeBase.load(KB_DIR)
                base = index_cache.index_dir(self.root, kb, api)
                # Другая модель за тем же псевдонимом — другой вектор контрольной фразы.
                original = index_cache.CANARY
                index_cache.CANARY = original + " другая модель"
                try:
                    other_model = index_cache.index_dir(self.root, kb, api)
                finally:
                    index_cache.CANARY = original
        kb.chunks[0].text += " правка"
        other_text = index_cache.content_digest(kb)
        self.assertNotEqual(base, other_model)
        self.assertNotEqual(base.name.split("-")[0], other_text)

    def test_no_model_no_cache(self):
        from energybot.llm import Api
        with _Env(LLM_BASE_URL="http://127.0.0.1:9/v1", LLM_API_KEY="k", EB_REQUEST_TIMEOUT="5"):
            self.assertIsNone(index_cache.index_dir(self.root, KnowledgeBase.load(KB_DIR), Api()))

    def test_prune_keeps_recent_and_drops_stale_tmp(self):
        for i in range(5):
            p = self.root / f"v{i}"
            p.mkdir()
            os.utime(p, (time.time() - 100 + i, time.time() - 100 + i))
        tmp = self.root / "v9.tmp-123"
        tmp.mkdir()
        os.utime(tmp, (time.time() - 7200, time.time() - 7200))
        index_cache.prune(self.root, keep=3)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["v2", "v3", "v4"])


if __name__ == "__main__":
    unittest.main()
