# Развёртывание: Vercel + Railway

Фронт (`web/`) живёт на Vercel, бэкенд — на Railway: Go-API, Python-ядро, шлюз к моделям, Postgres, Redis и
Prometheus.

```
браузер ──▶ Vercel: Next (web/) ──/api/*──▶ Railway: api (backend/, Go) ──приватная сеть──▶ Railway: core (scripts/core_api.py)
                 EB_API_URL, EB_API_TOKEN          │ EB_API_TOKEN, EB_CORE_URL                    EB_CORE_TOKEN
                                                   ├──▶ Railway: Postgres (заявки, оценки, журнал ответов)
                                                   ├──▶ Railway: Redis (пределы частоты)
                                                   └──▶ Railway: llm-gateway ◀── core     ──▶ провайдер модели
                                                        (LiteLLM, ключ провайдера — только здесь; база llm-db)
Railway: prometheus ──▶ /metrics api и llm-gateway
Railway: grafana ──▶ prometheus (приватная сеть)
```

| Что | Где | Публичный адрес |
|---|---|---|
| Стенд и виджет | Vercel, корень проекта `web` | да |
| API | Railway, служба `api`, корень `/backend` | да — к нему ходит сервер Next |
| Ядро | Railway, служба `core`, корень `/` | нет — только приватная сеть |
| База | Railway, `Postgres` | нет — только приватная сеть |
| Шлюз к моделям | Railway, служба `llm-gateway`, корень `/llm-gateway` | нет — только приватная сеть |
| База шлюза | Railway, второй PostgreSQL `llm-db` | нет — только приватная сеть |
| Redis | Railway, `Redis` | нет — только приватная сеть |
| Метрики | Railway, служба `prometheus`, корень `/monitoring` | по желанию — интерфейс Prometheus |
| Дашборды | Railway, служба `grafana`, корень `/monitoring/grafana` | по желанию — только с паролем |

Тот же набор служб поднимается локально одной командой — `docker compose up --build` (см. `compose.yaml`), вместе с фронтом на http://localhost:3000.

## Автодеплой: слияние dev → main и есть выкладка

Railway сам следит за веткой `main` и выкладывает каждый новый коммит в ней — но с включённым
**Wait for CI** только после того, как на этом коммите зелёные проверки GitHub Actions
(`.github/workflows/backend.yml`: Go-тесты на настоящем Postgres, сборка обоих образов, сквозной прогон
через docker compose; плюс `ci.yml`). Красное в бой не едет.

Каждая служба пересобирается, только если менялись её файлы (Watch Paths в настройках службы): правка
фронта не перезапускает ядро, правка базы знаний не перезапускает API.

Vercel выкладывает фронт из той же ветки `main` своей интеграцией с GitHub. Сборки других веток и PR
(превью) выключены: `ignoreCommand` в `web/vercel.json` пропускает всё, что не `main`. В PR проверка
Vercel поэтому показывает пропущенную сборку — это ожидаемо. Сборку фронта на PR проверяет CI
(`ci.yml`, job TypeScript: линтер и типы).

## Настройка один раз

Проект на Railway — `energytool` (регион EU West, Амстердам). Настройки служб хранятся в самом Railway:
config-as-code (`railway.json`) Railway для новых проектов больше не читает, поэтому таких файлов в
репозитории нет. Ниже — что выставлено, чтобы повторить или сверить.

### 1. Railway: базы и Redis

- New → Database → **PostgreSQL**. Служба называется `Postgres`, публичного адреса нет.
- New → Database → **PostgreSQL** ещё раз, назвать `llm-db` — база шлюза к моделям. Отдельная, а не схема в
  `Postgres`: LiteLLM сам ведёт в ней свою схему (Prisma), и пускать её к заявкам незачем.
- New → Database → **Redis**. Служба называется `Redis` — пределы частоты, общие для всех реплик `api`.

### 1a. Railway: служба `llm-gateway` (шлюз к моделям)

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | `/llm-gateway` |
| Dockerfile Path | `Dockerfile` (внутри `/llm-gateway`) |
| Watch Paths | `/llm-gateway/**` |
| Healthcheck | `/health/liveliness`, тайм-аут 180 с (миграции базы шлюза на первом старте) |
| Restart Policy | On Failure, 5 попыток |
| Public Networking | **не включать** |

| Переменная | Значение |
|---|---|
| `GW_HOST` | `::` — приватная сеть Railway адресует по IPv6 |
| `PORT` | `4000` — обязательно: Railway сам задаёт `PORT=8080` |
| `LITELLM_MASTER_KEY` | `sk-` + `openssl rand -hex 24` — ключ администратора шлюза |
| `DATABASE_URL` | `${{llm-db.DATABASE_URL}}` |
| `GW_KEY_CORE`, `GW_KEY_API` | `sk-` + `openssl rand -hex 24` каждый — ключи ядра и api; шлюз создаёт их в своей базе при старте |
| `GW_BASE_URL`, `GW_API_KEY` | адрес и ключ провайдера модели (раньше это были `LLM_BASE_URL`, `LLM_API_KEY` ядра) |
| `GW_CHAT_MODEL` | `openai/qwen/qwen3.8-27b` — префикс `openai/` = OpenAI-совместимый сервер |
| `GW_EMBED_MODEL` | `openai/baai/bge-m3` |
| `GW_RERANK_MODEL` | `hosted_vllm/qwen/qwen3-reranker-8b` |
| `GW_FALLBACK_BASE_URL`, `GW_FALLBACK_API_KEY`, `GW_FALLBACK_CHAT_MODEL` | запасной провайдер той же модели; не заданы — запаса нет |
| `GW_KEY_CORE_RPM`, `GW_KEY_API_RPM`, `…_PARALLEL`, `…_BUDGET` | пределы ключей (по умолчанию 240 и 60 запросов в минуту, 16 и 4 одновременных, бюджета нет) |
| `GW_CHAT_PRICE_IN`, `GW_CHAT_PRICE_OUT`, `GW_EMBED_PRICE_IN` | цена за миллион токенов, $; без цен расход считается нулевым и бюджеты не срабатывают |

Ключ api даёт только `energy-chat`; ключ ядра — все `energy-*`. Подробности и проверенное поведение —
`llm-gateway/README.md`.

### 2. Railway: служба `core` (Python-ядро)

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | пусто (корень репозитория: ядру нужны `energybot/` и `knowledge-base/`) |
| Dockerfile Path | `core/Dockerfile` |
| Watch Paths | `/core/**`, `/energybot/**`, `/knowledge-base/**`, `/scripts/core_api.py`, `/scripts/index_cache.py`, `/solution-requirements.txt` |
| Volume | смонтировать в `/data/index` — кеш векторов базы между выкладками |
| Healthcheck | `/healthz`, тайм-аут 300 с (ядро на старте считает эмбеддинги базы) |
| Restart Policy | On Failure, 5 попыток |
| Public Networking | **не включать** |

| Переменная | Значение |
|---|---|
| `EB_CORE_HOST` | `::` — приватная сеть Railway адресует по IPv6 |
| `EB_CORE_PORT` | `8788` |
| `PORT` | `8788` — обязательно: Railway сам задаёт службе `PORT=8080`, ядро слушает `PORT` раньше своего `EB_CORE_PORT`, и без этой строки `api` стучится на 8788 в закрытый порт |
| `EB_CORE_TOKEN` | длинная случайная строка (`openssl rand -hex 32`) — общая с `api` |
| `LLM_BASE_URL` | `http://${{llm-gateway.RAILWAY_PRIVATE_DOMAIN}}:4000/v1` |
| `LLM_API_KEY` | `${{llm-gateway.GW_KEY_CORE}}` |
| `LLM_MODEL`, `EMB_MODEL`, `RERANKER_MODEL` | `energy-chat`, `energy-embed`, `energy-rerank` |
| `EB_INDEX_CACHE_DIR` | `/data/index` |
| `EB_LOG_FORMAT` | `json` — журнал строками JSON с `request_id` |
| `EB_THINKING_PARAM`, остальные `EB_*` | как в `.env` (см. `.env.example`) |

Ключ провайдера ядру не нужен — его знает только шлюз. Если на старте модель недоступна, ядро отвечает на
BM25 и само достраивает векторы в фоне раз в `EB_DENSE_RETRY_SEC` (30 с): порядок старта служб не важен.

Ядро в образе работает не от root, а том Railway монтируется владельцем root. Если в журнале ядра «кеш не
записан: Permission denied» — нужен `RAILWAY_RUN_UID=0` у службы (по документации Railway — запуск от root ради
прав на том) либо работа без кеша. Без тома кеш живёт до перезапуска контейнера.

### 3. Railway: служба `api` (Go)

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | `/backend` |
| Dockerfile Path | `Dockerfile` (внутри `/backend`) |
| Watch Paths | `/backend/**` |
| Healthcheck | `/healthz`, тайм-аут 120 с |
| Restart Policy | On Failure, 5 попыток |
| Public Networking | домен Railway, порт 8080 — этот адрес нужен Vercel |

| Переменная | Значение |
|---|---|
| `EB_DB_DSN` | `${{Postgres.DATABASE_URL}}` |
| `EB_CORE_URL` | `http://${{core.RAILWAY_PRIVATE_DOMAIN}}:8788` |
| `EB_CORE_TOKEN` | `${{core.EB_CORE_TOKEN}}` |
| `EB_API_TOKEN` | ещё одна случайная строка — общая с Vercel |
| `EB_ADMIN_TOKEN` | токен администратора `/settings` (не короче 32 знаков) — общий с Vercel; без него глобальные настройки RAG закрыты, работает только песочница |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | `${{core.LLM_BASE_URL}}`, `${{llm-gateway.GW_KEY_API}}`, `energy-chat` — тот же шлюз, свой ключ |
| `EB_THINKING_PARAM` | `${{core.EB_THINKING_PARAM}}` |
| `PORT` | `8080` — тот же порт, что у домена |
| `EB_REDIS_URL` | `${{Redis.REDIS_URL}}` — пределы частоты общие для всех реплик; без него — в памяти, верно для одной реплики |
| `EB_RETENTION_LEADS_DAYS`, `…_ANSWERS_DAYS`, `…_FEEDBACK_DAYS` | сроки хранения ПДн, по умолчанию 90 / 30 / 90 — утвердить у оператора (`docs/privacy.md`) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `200` — сколько Railway ждёт между SIGTERM и SIGKILL. API ждёт текущие ответы до `EB_CORE_TIMEOUT` + 15 с; меньшее значение обрывает их на середине. Имя переменной сверить в настройках Railway при первой выкладке |

Метрики api — `:9091/metrics`, только из приватной сети; их забирает служба `prometheus`.

`EB_ENV` не задаётся: без него запуск считается боевым, и API
откажется стартовать без базы, токенов и пределов частоты — это защита, а не помеха.

Схему базы API накатывает сам при старте (миграции вшиты в бинарник), ручных шагов нет.

### 3a. Railway: служба `prometheus` (метрики)

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | `/monitoring` |
| Dockerfile Path | `Dockerfile` (внутри `/monitoring`) |
| Watch Paths | `/monitoring/**` |
| Healthcheck | `/-/ready`, тайм-аут 60 с |
| Volume | по желанию — в `/prometheus`; без него ряды теряются при выкладке (та же оговорка о правах, что у ядра: образ работает от nobody) |
| Public Networking | по желанию — интерфейс Prometheus (графики, вкладка Alerts с правилами `monitoring/rules.yml`) |

| Переменная | Значение |
|---|---|
| `API_TARGET` | `${{api.RAILWAY_PRIVATE_DOMAIN}}:9091` |
| `GATEWAY_TARGET` | `${{llm-gateway.RAILWAY_PRIVATE_DOMAIN}}:4000` |
| `STAND` | `railway` |
| `LISTEN` | `[::]:9090` — приватная сеть Railway адресует по IPv6 |

### 3b. Railway: служба `grafana` (дашборды)

Образ собирается из `monitoring/grafana/Dockerfile`: дашборды и provisioning (источник данных Prometheus) вшиты в
образ, ручной настройки в интерфейсе нет. Новые дашборды выкладываются обычным деплоем службы.

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | `/monitoring/grafana` |
| Dockerfile Path | `Dockerfile` (внутри `/monitoring/grafana`) |
| Watch Paths | `/monitoring/grafana/**` |
| Healthcheck | `/api/health`, тайм-аут 60 с |
| Volume | в `/var/lib/grafana`: пользователи, настройки и сессии переживают выкладку (образ работает от uid 472; если том не пишется, задать `RAILWAY_RUN_UID=0`). Дашборды из тома не зависят — они в образе |
| Public Networking | по желанию. Без публичного домена открыть Grafana можно только из приватной сети; домен включать лишь после того, как задан пароль |

| Переменная | Значение |
|---|---|
| `GF_SECURITY_ADMIN_PASSWORD` | длинный случайный пароль; **задать до включения публичного домена** (без него у Grafana `admin` / `admin`). Только в переменных Railway, в репозиторий не попадает |
| `GF_AUTH_ANONYMOUS_ENABLED` | `false` |
| `GF_USERS_ALLOW_SIGN_UP` | `false` |
| `GF_SERVER_HTTP_PORT` | `3000` — тот же порт, что у домена |
| `GF_SERVER_HTTP_ADDR` | `::` — приватная сеть Railway адресует по IPv6 |
| `GF_SERVER_ROOT_URL` | публичный адрес Grafana, если включён домен |
| `GF_ANALYTICS_REPORTING_ENABLED`, `GF_ANALYTICS_CHECK_FOR_UPDATES` | `false` |
| `PROMETHEUS_URL` | `http://${{prometheus.RAILWAY_PRIVATE_DOMAIN}}:9090` |

Проверка: `GET /api/health` отвечает без входа; `GET /api/search` без пароля — 401; после входа видны три дашборда
(«Консультант», «Модель и шлюз», «Заявки»). Сами `/metrics` api и шлюза остаются только в приватной сети.

### 4. Vercel: фронт

Project → Settings:

| Настройка | Значение |
|---|---|
| Root Directory | `web` |
| Git → Production Branch | `main` |
| Environment Variables → `EB_API_URL` | публичный адрес `api` на Railway, `https://….up.railway.app` |
| Environment Variables → `EB_API_TOKEN` | то же значение, что у `api` |
| Environment Variables → `EB_ADMIN_TOKEN` | то же значение, что у `api`: вход администратора на `/settings` |
| Environment Variables → `EB_STAND_URL` | адрес стенда сайта МТС, если он развёрнут |

Браузер в Railway не ходит: все запросы идут на `/api/*` того же домена Vercel, и уже сервер Next
пересылает их в API с токеном и настоящим адресом посетителя (`X-Client-IP`, по нему считаются пределы
частоты). Поэтому CORS на API не нужен, а токен не попадает в браузер.

Ответ модели идёт потоком до пары минут; маршрут прокси объявляет `maxDuration = 300`, чтобы Vercel не
обрывал его на середине.

## Проверка после выкладки

```bash
sh backend/scripts/smoke.sh https://<api>.up.railway.app <EB_API_TOKEN>
```

Скрипт проходит путь фронта целиком: состояние, база знаний, ответ потоком, заявка, оценка, отказ без
токена и на плохом теле. Он создаёт одну тестовую заявку с именем «Смоук».

## Переменные API

| Переменная | Умолчание | Смысл |
|---|---|---|
| `EB_ENV` | — (бой) | `development` выключает проверку конфигурации при старте |
| `EB_DB_DSN` / `DATABASE_URL` | — | адрес Postgres |
| `EB_DB_MIGRATE` | `true` | накатывать ли схему при старте |
| `EB_CORE_URL` | `http://127.0.0.1:8788` | адрес ядра |
| `EB_CORE_TOKEN` | — | общий секрет с ядром; в бою обязателен |
| `EB_CORE_TIMEOUT` | `3m` | потолок на один ответ ядра |
| `EB_API_TOKEN` | — | общий секрет с прокси Next; в бою обязателен |
| `EB_ADMIN_TOKEN` | — | токен администратора: только с ним `POST /api/settings` меняет настройки RAG для всех; пусто — закрыто для всех |
| `EB_MANAGER_TOKEN` | — | токен менеджера: разговоры клиентов `GET /api/sessions/:id` (и экран менеджера, T5); пусто — закрыто для всех |
| `EB_ALLOWED_ORIGINS` | — | CORS, только для вызовов из браузера напрямую |
| `EB_LIMIT_CHAT_PER_MINUTE` / `_BURST` | 20 / 5 | вопросов с адреса |
| `EB_LIMIT_LEAD_PER_HOUR` / `_BURST` | 10 / 3 | заявок с адреса |
| `EB_LIMIT_FEEDBACK_PER_MINUTE` / `_BURST` | 30 / 10 | оценок с адреса |
| `EB_LIMIT_SETTINGS_PER_MINUTE` / `_BURST` | 10 / 5 | запросов к настройкам и попыток входа администратора с адреса |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | — | модель для резюме заявок; без неё резюме — список вопросов |
| `EB_SUMMARY_TIMEOUT` | `30s` | тайм-аут одного запроса резюме |
| `EB_REDIS_URL` / `REDIS_URL` | — | Redis для пределов частоты; без него — память реплики |
| `EB_SHUTDOWN_TIMEOUT` | `EB_CORE_TIMEOUT` + 15 с | сколько ждать текущие ответы при остановке; меньше `EB_CORE_TIMEOUT` не принимается |
| `EB_SSE_HEARTBEAT` | `15s` | комментарий в поток, пока ядро думает; `0` — выкл. |
| `EB_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `EB_LOG_FORMAT` | `json` в бою, `console` в разработке | формат журнала |
| `EB_METRICS_PORT` | `9091` | порт `/metrics`; `0` — выкл. |
| `EB_RETENTION_LEADS_DAYS` | `90` | срок хранения заявок; в бою не может быть 0 |
| `EB_RETENTION_ANSWERS_DAYS` | `30` | срок хранения журнала ответов |
| `EB_RETENTION_FEEDBACK_DAYS` | `90` | срок хранения оценок |
| `EB_RETENTION_INTERVAL` | `1h` | как часто чистить |
