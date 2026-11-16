# Prometheus стенда: сбор метрик api и шлюза к моделям, правила тревог.
FROM prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06

COPY prometheus.yml.tmpl rules.yml entrypoint.sh /etc/prometheus/

EXPOSE 9090
ENTRYPOINT ["/bin/sh", "/etc/prometheus/entrypoint.sh"]
