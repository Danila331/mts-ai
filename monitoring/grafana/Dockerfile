# Grafana стенда для Railway: дашборды и provisioning из репозитория.
# Локально compose.yaml берёт тот же образ и монтирует эти же файлы.
FROM grafana/grafana:12.3.0@sha256:70d9599b186ce287be0d2c5ba9a78acb2e86c1a68c9c41449454d0fc3eeb84e8

COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana/dashboards

EXPOSE 3000
