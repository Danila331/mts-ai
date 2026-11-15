#!/bin/sh
# Запуск шлюза: конфиг без незаданных деплойментов → LiteLLM → ключи служб.
#
# GW_HOST — адрес прослушивания, по умолчанию 0.0.0.0. Не «::»: на нём
# Uvicorn слушает только IPv6, и healthcheck Railway не проходит.
# PORT задаёт хостинг.
#
# Ключи служб создаются после старта LiteLLM: им нужна его база и API.
# LiteLLM работает в фоне, а сигналы остановки передаются ему — иначе
# docker и Railway ждали бы до SIGKILL.
set -eu
python /gw/render.py /gw/config.yaml /tmp/litellm.yaml

port="${PORT:-4000}"
litellm --config /tmp/litellm.yaml --host "${GW_HOST:-0.0.0.0}" --port "$port" --num_workers 1 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

# Готовность шлюза — это и ключи служб: ядро, пришедшее со своим ключом
# раньше них, получило бы 401. Healthcheck ждёт этот файл.
ready=/tmp/gw-ready
rm -f "$ready"
if [ -n "${DATABASE_URL:-}" ]; then
  # Сбой синхронизации ключей не роняет шлюз: ключи, уже лежащие в базе,
  # продолжают работать, причина — в журнале.
  if python /gw/keys.py "http://127.0.0.1:$port"; then
    touch "$ready"
  else
    echo "llm-gateway: ключи служб не синхронизированы" >&2
  fi
else
  echo "llm-gateway: DATABASE_URL не задан — ключей служб нет, службы ходят с LITELLM_MASTER_KEY" >&2
  touch "$ready"
fi

# wait прерывается сигналом — тогда ждём ещё раз, пока LiteLLM не выйдет.
set +e
wait "$pid"
status=$?
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid"
  status=$?
done
exit "$status"
