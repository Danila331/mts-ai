#!/bin/sh
# Сквозная проверка поднятого бэкенда запросами фронта.
#
#   sh backend/scripts/smoke.sh [адрес API] [EB_API_TOKEN]
#
# Проверяет связность: прокси → API → ядро → база. Качество ответа здесь
# не проверяется — без ключа модели ядро отвечает заглушкой, и это тоже
# ответ.
set -eu

api="${1:-http://127.0.0.1:8787}"
token="${2:-}"
auth=""
if [ -n "$token" ]; then auth="Authorization: Bearer $token"; fi

fail() { echo "FAIL: $*" >&2; exit 1; }

call() { # метод путь [тело]
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H "Content-Type: application/json" -H "$auth" --data "$3" "$api$2"
  else
    curl -sS -X "$1" -H "$auth" "$api$2"
  fi
}

code=$(curl -s -o /dev/null -w '%{http_code}' "$api/healthz")
[ "$code" = 200 ] || fail "/healthz: $code"

if [ -n "$token" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$api/api/health")
  [ "$code" = 401 ] || fail "/api/health без токена: $code, ожидался 401"
fi

call GET /api/health | grep -q '"db":true' || fail "/api/health: нет db=true"
call GET /api/kb | grep -q '"docs"' || fail "/api/kb: нет docs"

stream=$(call POST /api/chat '{"messages":[{"role":"user","content":"Что такое АСКУЭ?"}],"mode":"chat"}')
echo "$stream" | grep -q '^event: answer' || fail "/api/chat: нет события answer: $(echo "$stream" | head -c 500)"
echo "$stream" | grep -q '^event: done' || fail "/api/chat: нет события done"

call POST /api/lead '{"name":"Смоук","phone":"+70000000000","company":"","comment":"","messages":[{"role":"user","content":"Нужен АСКУЭ"}]}' \
  | grep -q '"summary"' || fail "/api/lead: нет summary"
call POST /api/feedback '{"session_id":"s","message_id":"m","rating":1}' \
  | grep -q '"ok":true' || fail "/api/feedback"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$auth" --data '{"messages":"x"}' "$api/api/chat")
[ "$code" = 400 ] || fail "/api/chat с плохим телом: $code, ожидался 400"

echo "smoke: ok ($api)"
