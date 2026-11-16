"""Ключи шлюза на службу: создаёт или приводит к описанию при каждом старте.

    python keys.py http://127.0.0.1:4000

Ключи хранятся в базе LiteLLM (DATABASE_URL). Значение ключа задаётся
окружением (GW_KEY_CORE, GW_KEY_API) и не генерируется здесь: его же
получают ядро и api, и оно не должно меняться от перезапуска шлюза.

У каждой службы — свои модели и пределы. Ядро не может звать что-то,
кроме energy-*, api — только energy-chat и energy-vision (текст с фото
документа, T9). Ключ api, утёкший из Go-службы,
не даёт ни эмбеддингов, ни бесконечных запросов.

Пределы (0 — без предела):
    GW_KEY_<SVC>_RPM       запросов в минуту
    GW_KEY_<SVC>_TPM       токенов в минуту
    GW_KEY_<SVC>_PARALLEL  одновременных запросов
    GW_KEY_<SVC>_BUDGET    долларов за GW_BUDGET_PERIOD (считается по ценам GW_*_PRICE_*; без цен — 0)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

SERVICES = {
    "core": {"models": ["energy-chat", "energy-chat-fallback", "energy-embed", "energy-rerank"],
             "rpm": 240, "tpm": 0, "parallel": 16, "budget": 0},
    "api": {"models": ["energy-chat", "energy-chat-fallback", "energy-vision"],
            "rpm": 60, "tpm": 0, "parallel": 4, "budget": 0},
}


def num(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"llm-gateway: {name}={raw!r} — не число, беру {default}", file=sys.stderr)
        return default


def call(base: str, master: str, method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {master}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def wait_ready(base: str, seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + "/health/readiness", timeout=3) as r:
                if r.status == 200 and json.loads(r.read()).get("db") == "connected":
                    return True
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1)
    return False


def spec(svc: str, defaults: dict) -> dict:
    up = svc.upper()
    limits = {
        "rpm_limit": int(num(f"GW_KEY_{up}_RPM", defaults["rpm"])),
        "tpm_limit": int(num(f"GW_KEY_{up}_TPM", defaults["tpm"])),
        "max_parallel_requests": int(num(f"GW_KEY_{up}_PARALLEL", defaults["parallel"])),
        "max_budget": num(f"GW_KEY_{up}_BUDGET", defaults["budget"]),
    }
    body = {"key_alias": f"energytool-{svc}", "models": defaults["models"], "metadata": {"service": svc}}
    # Ноль — «без предела»: LiteLLM понимает это как null, а не как «ноль запросов».
    body.update({k: (v or None) for k, v in limits.items()})
    if body["max_budget"]:
        body["budget_duration"] = os.environ.get("GW_BUDGET_PERIOD", "30d")
    return body


def main() -> int:
    base = sys.argv[1].rstrip("/")
    master = os.environ["LITELLM_MASTER_KEY"]
    # На пустой базе LiteLLM сначала накатывает всю историю своей схемы (220+ миграций); на хостинге с базой
    # по сети это минуты. Ждать меньше — значит не создать ключи служб на первом старте.
    if not wait_ready(base, int(num("GW_KEYS_WAIT_SEC", 600))):
        print("llm-gateway: база шлюза не ответила — ключи служб не синхронизированы", file=sys.stderr)
        return 1
    failed = 0
    for svc, defaults in SERVICES.items():
        key = os.environ.get(f"GW_KEY_{svc.upper()}", "").strip()
        if not key:
            print(f"llm-gateway: GW_KEY_{svc.upper()} не задан — служба {svc} ходит с master key", file=sys.stderr)
            continue
        # Правила LiteLLM для своих ключей: префикс sk- и не короче 16 знаков.
        # Генерировать — openssl rand -hex 24 с префиксом sk-.
        if not key.startswith("sk-") or len(key) < 16:
            print(f"llm-gateway: GW_KEY_{svc.upper()} должен начинаться с sk- и быть не короче 16 знаков",
                  file=sys.stderr)
            failed += 1
            continue
        body = spec(svc, defaults)
        status, _ = call(base, master, "GET", f"/key/info?key={key}")
        if status == 200:
            status, resp = call(base, master, "POST", "/key/update", {"key": key, **body})
            action = "обновлён"
        else:
            status, resp = call(base, master, "POST", "/key/generate", {"key": key, **body})
            action = "создан"
        if status != 200:
            print(f"llm-gateway: ключ {svc} не {action}: HTTP {status} {str(resp)[:300]}", file=sys.stderr)
            failed += 1
            continue
        limits = {k: body[k] for k in ("models", "rpm_limit", "tpm_limit", "max_parallel_requests", "max_budget")}
        print(f"llm-gateway: ключ {svc} {action}: {limits}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
