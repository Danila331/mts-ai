"""Готовит конфиг LiteLLM к запуску: выключает незаданные деплойменты.

    python render.py config.yaml /tmp/litellm.yaml

Деплоймент, у которого хотя бы одна переменная os.environ/X не задана,
выкидывается вместе со ссылками на него в fallbacks. Так запасной
провайдер включается одной переменной окружения, а не правкой файла, и
незаданный запас не превращается в запросы на api.openai.com.

Значения переменных в файл не подставляются — это делает сам LiteLLM:
ключи не оседают на диске контейнера.
"""
import os
import sys

import yaml

PREFIX = "os.environ/"


def missing_vars(params: dict) -> list:
    out = []
    for value in params.values():
        if isinstance(value, str) and value.startswith(PREFIX):
            name = value[len(PREFIX):]
            if not os.environ.get(name, "").strip():
                out.append(name)
    return out


def render(cfg: dict) -> tuple[dict, list]:
    kept, dropped = [], []
    for entry in cfg.get("model_list") or []:
        missing = missing_vars(entry.get("litellm_params") or {})
        if missing:
            dropped.append((entry["model_name"], missing))
        else:
            kept.append(entry)
    cfg["model_list"] = kept
    alive = {e["model_name"] for e in kept}

    router = cfg.get("router_settings") or {}
    fallbacks = []
    for rule in router.get("fallbacks") or []:
        for name, targets in rule.items():
            targets = [t for t in targets if t in alive]
            if name in alive and targets:
                fallbacks.append({name: targets})
    if "fallbacks" in router:
        router["fallbacks"] = fallbacks
    return cfg, dropped


# Цены — за миллион токенов, в долларах. Без них LiteLLM считает расход
# нулевым, и бюджеты ключей (GW_KEY_*_BUDGET) никогда не срабатывают.
PRICES = {
    "energy-chat": ("GW_CHAT_PRICE_IN", "GW_CHAT_PRICE_OUT"),
    "energy-chat-fallback": ("GW_FALLBACK_PRICE_IN", "GW_FALLBACK_PRICE_OUT"),
    "energy-embed": ("GW_EMBED_PRICE_IN", None),
    "energy-vision": ("GW_VISION_PRICE_IN", "GW_VISION_PRICE_OUT"),
}


def apply_prices(cfg: dict) -> None:
    for entry in cfg.get("model_list") or []:
        names = PRICES.get(entry["model_name"])
        if not names:
            continue
        info = {}
        for field, var in zip(("input_cost_per_token", "output_cost_per_token"), names):
            raw = os.environ.get(var or "", "").strip()
            if raw:
                info[field] = float(raw) / 1_000_000
        if info:
            entry.setdefault("model_info", {}).update(info)


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        cfg, dropped = render(yaml.safe_load(f))
    apply_prices(cfg)
    if not os.environ.get("LITELLM_MASTER_KEY", "").strip():
        print("llm-gateway: LITELLM_MASTER_KEY не задан — шлюз был бы открыт всем", file=sys.stderr)
        return 1
    for name, missing in dropped:
        print(f"llm-gateway: {name} выключен — не заданы {', '.join(missing)}", file=sys.stderr)
    names = [e["model_name"] for e in cfg["model_list"]]
    if "energy-chat" not in names:
        # Не авария: стенд без ключа модели поднимается и честно отвечает
        # заглушкой, как и до шлюза. Причина — здесь, в журнале шлюза.
        print("llm-gateway: energy-chat не настроен (GW_CHAT_MODEL, GW_BASE_URL, GW_API_KEY) — "
              "запросы к модели получат отказ", file=sys.stderr)
    fallbacks = (cfg.get("router_settings") or {}).get("fallbacks") or "нет"
    print(f"llm-gateway: модели {', '.join(names) or 'нет'}; запас {fallbacks}", file=sys.stderr)
    with open(dst, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
