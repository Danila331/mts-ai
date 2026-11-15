# Prometheus стенда: сбор метрик api и шлюза к моделям, правила тревог.
FROM prom/prometheus:v3.16.0

COPY prometheus.yml.tmpl rules.yml entrypoint.sh /etc/prometheus/

EXPOSE 9090
ENTRYPOINT ["/bin/sh", "/etc/prometheus/entrypoint.sh"]
