#!/bin/sh
# Конфиг Prometheus с адресами целей из окружения, затем сам Prometheus.
#
#   API_TARGET      адрес /metrics Go-API      (compose: api:9091)
#   GATEWAY_TARGET  адрес шлюза к моделям      (compose: llm-gateway:4000)
#   STAND           метка стенда в метриках    (local, railway…)
#   RETENTION       сколько хранить ряды       (по умолчанию 15d)
set -eu
: "${API_TARGET:?не задан}" "${GATEWAY_TARGET:?не задан}"
sed -e "s|\${API_TARGET}|${API_TARGET}|g" \
    -e "s|\${GATEWAY_TARGET}|${GATEWAY_TARGET}|g" \
    -e "s|\${STAND}|${STAND:-local}|g" \
    /etc/prometheus/prometheus.yml.tmpl > /prometheus/prometheus.yml
exec /bin/prometheus --config.file=/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time="${RETENTION:-15d}" \
  --web.listen-address="${LISTEN:-:9090}"
