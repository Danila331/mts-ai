"""Кэш эмбеддингов запроса (T32) в WebApi: повтор нормализованного текста не ходит в провайдера.

    python -m unittest tests.test_embed_cache -v
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

_saved_env = dict(os.environ)
import core_api  # noqa: E402

from energybot.llm import Api  # noqa: E402

os.environ.clear()
os.environ.update(_saved_env)


def fake_embed(self, texts, batch=None):
    fake_embed.calls.append(list(texts))
    return [[float(len(t)), 1.0] for t in texts]


class EmbedCache(unittest.TestCase):
    def setUp(self):
        fake_embed.calls = []
        self.api = core_api.WebApi()
        self.api.base_url = ""

    def test_repeat_and_normalization_hit_cache(self):
        with mock.patch.object(Api, "embed", fake_embed):
            a = self.api.embed(["Сколько стоит  счётчик?"])
            b = self.api.embed(["  сколько стоит счётчик? "])
        self.assertEqual(a, b)
        self.assertEqual(len(fake_embed.calls), 1)
        self.assertEqual((self.api.embed_hits, self.api.embed_misses), (1, 1))

    def test_different_text_not_merged(self):
        with mock.patch.object(Api, "embed", fake_embed):
            self.api.embed(["цена счётчика"])
            self.api.embed(["цена счётчика?"])
        self.assertEqual(len(fake_embed.calls), 2)

    def test_partial_batch_requests_only_missing(self):
        with mock.patch.object(Api, "embed", fake_embed):
            self.api.embed(["один"])
            out = self.api.embed(["один", "два"])
        self.assertEqual(fake_embed.calls[-1], ["два"])
        self.assertEqual(out[0], [4.0, 1.0])
        self.assertEqual(len(out), 2)

    def test_large_batches_bypass_cache(self):
        with mock.patch.object(Api, "embed", fake_embed):
            self.api.embed([f"фрагмент {i}" for i in range(10)])
        self.assertEqual(len(self.api._embed_cache), 0)

    def test_cache_is_bounded(self):
        self.api.EMBED_CACHE_MAX = 3
        with mock.patch.object(Api, "embed", fake_embed):
            for i in range(6):
                self.api.embed([f"вопрос {i}"])
        self.assertEqual(len(self.api._embed_cache), 3)


if __name__ == "__main__":
    unittest.main()
