#!/bin/sh
# Сквозная проверка поднятого стенда запросами фронта.
#
#   sh backend/scripts/smoke.sh [адрес API] [EB_API_TOKEN] [адрес стенда]
#
# Проверяет связность: стенд → прокси Next → API → ядро → база. Качество
# ответа здесь не проверяется — без ключа модели ядро отвечает заглушкой,
# и это тоже ответ. Стенд (третий аргумент, например
# http://127.0.0.1:3000 из compose.yaml) проверяется, только если задан.
set -eu

api="${1:-http://127.0.0.1:8787}"
token="${2:-}"
web="${3:-}"
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

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$auth" -H "Content-Type: application/json" \
  --data '{"name":"Смоук","phone":"+70000000000","messages":[]}' "$api/api/lead")
[ "$code" = 400 ] || fail "/api/lead без согласия: $code, ожидался 400"
call POST /api/lead '{"name":"Смоук","phone":"+70000000000","company":"","comment":"","consent":true,"messages":[{"role":"user","content":"Нужен АСКУЭ"}]}' \
  | grep -q '"summary"' || fail "/api/lead: нет summary"
call POST /api/feedback '{"session_id":"s","message_id":"m","rating":1}' \
  | grep -q '"ok":true' || fail "/api/feedback"

# Сессия (T1): два вопроса одного разговора — одна сессия и две пары реплик
# на сервере. История видна только менеджеру — с SMOKE_MANAGER_TOKEN.
sid="smoke-$(date +%s)"
call POST /api/chat "{\"messages\":[{\"role\":\"user\",\"content\":\"Что такое АСКУЭ?\"}],\"mode\":\"chat\",\"session_id\":\"$sid\",\"channel\":\"embed\"}" \
  | grep -q '^event: done' || fail "/api/chat с сессией: нет события done"
call POST /api/chat "{\"messages\":[{\"role\":\"user\",\"content\":\"Что такое АСКУЭ?\"},{\"role\":\"assistant\",\"content\":\"Ответ\"},{\"role\":\"user\",\"content\":\"А для склада?\"}],\"mode\":\"chat\",\"session_id\":\"$sid\",\"channel\":\"embed\"}" \
  | grep -q '^event: done' || fail "/api/chat, второй вопрос сессии: нет события done"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" "$api/api/sessions/$sid")
[ "$code" = 401 ] || fail "/api/sessions без токена менеджера: $code, ожидался 401"
if [ -n "${SMOKE_MANAGER_TOKEN:-}" ]; then
  history=$(curl -sS -H "$auth" -H "X-Manager-Token: $SMOKE_MANAGER_TOKEN" "$api/api/sessions/$sid")
  n=$(echo "$history" | grep -o '"role":"user"' | wc -l | tr -d ' ')
  [ "$n" = 2 ] || fail "/api/sessions/$sid: реплик клиента $n, ожидалось 2: $(echo "$history" | head -c 500)"
  echo "$history" | grep -q '"channel":"embed"' || fail "/api/sessions/$sid: канал не embed"
fi

# Глобальные настройки RAG — только администратору: токена прокси мало.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$auth" -H "Content-Type: application/json" \
  --data '{"values":{"top_k":5}}' "$api/api/settings")
[ "$code" = 401 ] || fail "/api/settings без токена администратора: $code, ожидался 401"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$auth" --data '{"messages":"x"}' "$api/api/chat")
[ "$code" = 400 ] || fail "/api/chat с плохим телом: $code, ожидался 400"

if [ -n "$web" ]; then
  for path in /playground /kb /widget /embed /widget.js; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$web$path")
    [ "$code" = 200 ] || fail "стенд $path: $code, ожидался 200"
  done
  # Прокси Next сам подставляет токен API: из браузера запрос идёт без него.
  curl -sS "$web/api/health" | grep -q '"db":true' || fail "стенд /api/health: прокси не дошёл до API"
  curl -sS "$web/api/kb" | grep -q '"docs"' || fail "стенд /api/kb: нет docs"
  stream=$(curl -sS -X POST -H "Content-Type: application/json" \
    --data '{"messages":[{"role":"user","content":"Что такое АСКУЭ?"}],"mode":"chat"}' "$web/api/chat")
  echo "$stream" | grep -q '^event: done' || fail "стенд /api/chat: нет события done: $(echo "$stream" | head -c 500)"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$web/api/not-allowed")
  [ "$code" = 404 ] || fail "стенд /api/not-allowed: $code, прокси пускает только свой список путей"
fi

echo "smoke: ok ($api${web:+, $web})"
