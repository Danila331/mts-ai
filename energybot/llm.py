"""Клиент OpenAI-совместимого API платформы: чат, эмбеддинги, реранкер."""

from __future__ import annotations

import os
import re
import sys
import time

import httpx


def env(name: str, default: str = "") -> str:
    value = os.getenv(name, "").strip()
    return default if not value or value == name else value


def env_num(name: str, default, lower, upper, kind=int):
    try:
        return max(lower, min(upper, kind(env(name))))
    except ValueError:
        return default


class DeadlineExceeded(RuntimeError):
    """Общий лимит времени прогона исчерпан — новых запросов не делаем."""


THINK = re.compile(r"<think>.*?</think>", re.S)
OVERFLOW = re.compile(r"context|too long|maximum.{0,40}tokens|token limit|exceed", re.I)


def context_overflow(response) -> bool:
    """Ответ 400 из-за слишком длинного промпта (а не из-за незнакомого параметра)."""
    try:
        return bool(OVERFLOW.search(response.text or ""))
    except Exception:  # noqa: BLE001
        return False


def strip_thinking(text: str) -> str:
    """Убирает размышления модели из ответа.

    Сервер может отдать их тремя способами: отдельным полем (тогда здесь чистый ответ), парой меток
    <think>…</think> или — как vLLM без разбора размышлений — текстом с одной закрывающей меткой
    (открывающая осталась в шаблоне запроса). Ответ клиенту — только то, что после последней </think>.
    """
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    text = THINK.sub("", text)
    if "<think>" in text:  # размышление не закрыто — ответа нет
        text = text.split("<think>")[0]
    return text.strip()


class Api:
    def __init__(self):
        # Регламент (раздел 6–7): генерация, эмбеддинги и реранкер — через один прокси платформы,
        # адрес и ключ — LLM_* или OPENAI_*. BASE_URL — запасное имя из примера организаторов, ниже по приоритету.
        self.base_url = (env("LLM_BASE_URL") or env("OPENAI_BASE_URL") or env("BASE_URL")).rstrip("/")
        self.llm_key = env("LLM_API_KEY") or env("OPENAI_API_KEY")
        # Отдельные ключи — как в примере сабмита организаторов (при их наличии).
        self.emb_key = env("EMBEDDER_API_KEY") or self.llm_key
        self.rerank_key = env("RERANKER_API_KEY") or self.llm_key
        # Отдельные адреса — только для локальной разработки (наш префикс EB_, платформа их не задаёт).
        self.emb_url = (env("EB_EMBEDDER_BASE_URL") or self.base_url).rstrip("/")
        self.rerank_url = (env("EB_RERANKER_BASE_URL") or self.base_url).rstrip("/")
        self.llm_model = env("LLM_MODEL") or env("GEN_MODEL") or env("OPENAI_MODEL", "qwen/qwen3.8-27b")
        self.emb_model = env("EMB_MODEL", "baai/bge-m3")
        self.rerank_model = env("RERANKER_MODEL", "qwen/qwen3-reranker-8b")
        # Свои имена (EB_*): платформа передаёт TOP_K, MAX_TOKENS, TEMPERATURE под бейзлайн,
        # и они не должны молча перебивать настройки нашего решения.
        self.max_tokens = env_num("EB_MAX_TOKENS", 700, 128, 8192)
        self.temperature = env_num("EB_TEMPERATURE", 0.0, 0.0, 2.0, float)
        self.timeout = env_num("EB_REQUEST_TIMEOUT", 60.0, 5.0, 600.0, float)
        self.embed_batch = env_num("EB_EMBED_BATCH", 16, 1, 256)
        self.use_embeddings = env("EB_USE_EMBEDDINGS", "1") != "0"
        self.can_rerank = env("EB_USE_RERANKER", "1") != "0"
        # Qwen3 — гибридная модель; режим размышлений отключаем ради скорости и чистого ответа.
        self.disable_thinking = env("EB_DISABLE_THINKING", "1") != "0"
        # chat_template_kwargs — vLLM (вероятно, прокси платформы); reasoning — OpenRouter;
        # enable_thinking — DashScope; none — ничего не слать.
        self.thinking_param = env("EB_THINKING_PARAM", "chat_template_kwargs")
        self.thinking_budget = env_num("EB_THINKING_BUDGET", 3000, 500, 16000)
        # Запрос с размышлениями — одна попытка с собственным тайм-аутом: не успел — отвечаем без размышлений.
        self.think_timeout = env_num("EB_THINK_TIMEOUT", 50.0, 5.0, 600.0, float)
        self.thinking_overflows = 0
        self._thinking_param_ok = True
        self.rejected_params = set()  # параметры сэмплинга, на которые сервер ответил 400
        # Дополнительный сэмплинг для всех запросов (эксперименты с настройками Qwen); по умолчанию пусто.
        self.default_extra = {}
        for key, name, kind, lo, hi in (("top_p", "EB_TOP_P", float, 0.05, 1.0),
                                        ("top_k", "EB_SAMPLE_TOP_K", int, 1, 200),
                                        ("presence_penalty", "EB_PRESENCE_PENALTY", float, 0.0, 2.0)):
            if env(name):
                self.default_extra[key] = env_num(name, None, lo, hi, kind)
        self.deadline = None  # абсолютное time.perf_counter(), после которого запросы не делаем
        self.client = httpx.Client(timeout=self.timeout)

    def _remaining(self):
        return None if self.deadline is None else self.deadline - time.perf_counter()

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.llm_key)

    def _post(self, url: str, key: str, body: dict, attempts: int = 3, timeout: float | None = None) -> dict:
        last = None
        limit = timeout or self.timeout
        for attempt in range(attempts):
            remaining = self._remaining()
            if remaining is not None and remaining < 3:
                raise DeadlineExceeded("исчерпан общий лимит времени прогона")
            timeout = limit if remaining is None else min(limit, remaining - 1)
            try:
                r = self.client.post(url, headers={"Authorization": f"Bearer {key}"}, json=body, timeout=timeout)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as exc:
                last = exc
                if exc.response is not None and exc.response.status_code in (400, 401, 403, 404, 422):
                    raise
            except (httpx.TimeoutException, httpx.TransportError, ValueError) as exc:
                last = exc
            if attempt + 1 < attempts:
                time.sleep(0.6 * (2 ** attempt))
        raise last

    # ---------- эмбеддинги ----------
    def embed(self, texts: list, batch: int | None = None) -> list:
        """Эмбеддинги пачками. Лимит размера пачки у провайдеров разный (бывает 20, 10…):
        при ответе 400 пачка уменьшается вдвое, и дальше используется уже меньший размер."""
        batch = batch or self.embed_batch
        out = []
        i = 0
        while i < len(texts):
            part = texts[i:i + batch]
            try:
                data = self._post(self.emb_url + "/embeddings", self.emb_key, {"model": self.emb_model, "input": part})
            except httpx.HTTPStatusError as exc:
                if exc.response is not None and exc.response.status_code == 400 and batch > 1:
                    batch = self.embed_batch = max(1, batch // 2)
                    continue
                raise
            items = sorted(data["data"], key=lambda d: d.get("index", 0))
            if len(items) != len(part):
                raise ValueError("Получены не все эмбеддинги")
            out.extend([float(x) for x in it["embedding"]] for it in items)
            i += len(part)
        return out

    # ---------- реранкер ----------
    def rerank(self, query: str, documents: list) -> list:
        data = self._post(self.rerank_url + "/rerank", self.rerank_key, {
            "model": self.rerank_model, "query": query, "documents": documents, "top_n": len(documents),
        }, attempts=2)
        scores = [float("-inf")] * len(documents)
        for item in data.get("results", data.get("data", [])):
            idx = int(item["index"])
            if 0 <= idx < len(documents):
                scores[idx] = float(item.get("relevance_score", item.get("score", 0.0)))
        return scores

    # ---------- генерация ----------
    def _thinking_fields(self, think: bool = False) -> dict:
        """Как включить или отключить размышления: у разных серверов разный параметр (EB_THINKING_PARAM)."""
        if not self._thinking_param_ok or (not think and not self.disable_thinking):
            return {}
        return {
            "chat_template_kwargs": {"chat_template_kwargs": {"enable_thinking": think}},  # vLLM / SGLang
            # OpenRouter: только провайдеры, которые поддерживают параметр, — иначе часть из них его
            # игнорирует или отклоняет, и модель думает (медленно, иногда пустой ответ).
            "reasoning": {"reasoning": {"enabled": think}, "provider": {"require_parameters": True}},
            "enable_thinking": {"enable_thinking": think},  # Alibaba DashScope
        }.get(self.thinking_param, {})

    def chat(self, messages: list, max_tokens: int | None = None, temperature: float | None = None,
             think: bool = False, extra: dict | None = None, thinking_fields: bool = True,
             retry_empty: bool = True) -> str:
        """think=True — ответ с размышлениями: одна попытка с тайм-аутом EB_THINK_TIMEOUT и запасом токенов
        на размышления. Пустая строка означает, что размышления не уложились в лимит, — вызывающий
        повторяет запрос без них. Если сервер не принимает параметр режима, размышления не запрашиваются.

        extra — дополнительные параметры сэмплинга (top_p, top_k, presence_penalty, reasoning_effort): если
        сервер отвечает на них 400, они запоминаются как неподдерживаемые и дальше не шлются.
        thinking_fields=False — не слать параметр отключения размышлений; retry_empty=False — не повторять
        пустой ответ внутри клиента (повтор делает вызывающий)."""
        think = think and self._thinking_param_ok
        max_tokens = max_tokens or self.max_tokens
        sampling = {k: v for k, v in {**self.default_extra, **(extra or {})}.items()
                    if k not in self.rejected_params and v is not None}
        body = {
            "model": self.llm_model,
            "messages": messages,
            "max_tokens": max_tokens + (self.thinking_budget if think else 0),
            "temperature": self.temperature if temperature is None else temperature,
            **(self._thinking_fields(think) if thinking_fields else {}),
            **sampling,
        }
        url = self.base_url + "/chat/completions"
        while True:
            try:
                if think:
                    data = self._post(url, self.llm_key, body, attempts=1, timeout=self.think_timeout)
                else:
                    data = self._post(url, self.llm_key, body)
                break
            except httpx.HTTPStatusError as exc:
                if exc.response is None or exc.response.status_code not in (400, 422) \
                        or context_overflow(exc.response):
                    raise
                # Сервер не знает параметр сэмплинга — больше его не шлём.
                unknown = [k for k in sampling if k in body]
                if unknown:
                    print(f"[llm] сервер отклонил {sorted(unknown)}, отправляем без них", file=sys.stderr)
                    self.rejected_params.update(unknown)
                    for key in unknown:
                        body.pop(key, None)
                    continue
                # Сервер не знает параметр режима размышлений — больше его не шлём.
                mode_fields = [k for k in self._thinking_fields(think) if k in body] if thinking_fields else []
                if not mode_fields:
                    raise
                print(f"[llm] сервер отклонил {sorted(mode_fields)}, отправляем без него", file=sys.stderr)
                self._thinking_param_ok = False
                for key in mode_fields:
                    body.pop(key, None)
                body["max_tokens"] = max_tokens
                think = False
        choice = data["choices"][0]
        text = strip_thinking(choice["message"].get("content") or "")
        if not text and not think and retry_empty and self._ran_out_thinking(choice, data):
            # Сервер проигнорировал отключение размышлений, и модель потратила весь лимит на них.
            # Один повтор с запасом токенов: медленнее, но без пустого ответа.
            self.thinking_overflows += 1
            body["max_tokens"] = max(self.thinking_budget, 3 * body["max_tokens"])
            data = self._post(url, self.llm_key, body)
            text = strip_thinking(data["choices"][0]["message"].get("content") or "")
        return text

    @staticmethod
    def _ran_out_thinking(choice: dict, data: dict) -> bool:
        message = choice.get("message") or {}
        details = (data.get("usage") or {}).get("completion_tokens_details") or {}
        return (choice.get("finish_reason") == "length"
                or bool(message.get("reasoning") or message.get("reasoning_content"))
                or bool(details.get("reasoning_tokens"))
                or "<think>" in (message.get("content") or ""))
