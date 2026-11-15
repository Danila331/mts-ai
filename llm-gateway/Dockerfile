# Шлюз к моделям — LiteLLM Proxy с конфигом стенда.
#
# Образ non_root — официальная сборка LiteLLM, работающая от nobody
# (65534): шлюз держит ключи провайдеров, и root ему не нужен.
#
# Версия закреплена: LiteLLM выпускается часто, и обновление — это
# решение с прогоном сценариев (llm-gateway/README.md), а не побочный
# эффект пересборки. LTS-ветка — та, что получает исправления дольше.
FROM ghcr.io/berriai/litellm-non_root:1.108.9-lts@sha256:49164609b06c4c579ea2f277177061a3339c10f26268ec7baf27ce104c1bce13

COPY config.yaml render.py keys.py entrypoint.sh /gw/

EXPOSE 4000
ENTRYPOINT ["/bin/sh", "/gw/entrypoint.sh"]
