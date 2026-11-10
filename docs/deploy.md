# Развёртывание: Vercel + Railway

Фронт (`web/`) живёт на Vercel, бэкенд — на Railway: Go-API, Python-ядро и Postgres.

```
браузер ──▶ Vercel: Next (web/) ──/api/*──▶ Railway: api (backend/, Go) ──приватная сеть──▶ Railway: core (scripts/core_api.py)
                 EB_API_URL, EB_API_TOKEN          │ EB_API_TOKEN, EB_CORE_URL                    EB_CORE_TOKEN, ключ модели
                                                   └──▶ Railway: Postgres (заявки, оценки, журнал ответов)
```

| Что | Где | Публичный адрес |
|---|---|---|
| Стенд и виджет | Vercel, корень проекта `web` | да |
| API | Railway, служба `api`, корень `/backend` | да — к нему ходит сервер Next |
| Ядро | Railway, служба `core`, корень `/` | нет — только приватная сеть |
| База | Railway, `Postgres` | нет — только приватная сеть |

Тот же набор служб поднимается локально одной командой — `docker compose up --build` (см. `docker-compose.yml`).

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

### 1. Railway: база

New → Database → **PostgreSQL**. Служба называется `Postgres`, публичного адреса нет.

### 2. Railway: служба `core` (Python-ядро)

| Настройка | Значение |
|---|---|
| Source | `Danila331/mts-ai`, ветка `main`, **Wait for CI** включён |
| Root Directory | пусто (корень репозитория: ядру нужны `energybot/` и `knowledge-base/`) |
| Dockerfile Path | `core/Dockerfile` |
| Watch Paths | `/core/**`, `/energybot/**`, `/knowledge-base/**`, `/scripts/core_api.py`, `/solution-requirements.txt` |
| Healthcheck | `/healthz`, тайм-аут 300 с (ядро на старте считает эмбеддинги базы) |
| Restart Policy | On Failure, 5 попыток |
| Public Networking | **не включать** |

| Переменная | Значение |
|---|---|
| `EB_CORE_HOST` | `::` — приватная сеть Railway адресует по IPv6 |
| `EB_CORE_PORT` | `8788` |
| `PORT` | `8788` — обязательно: Railway сам задаёт службе `PORT=8080`, ядро слушает `PORT` раньше своего `EB_CORE_PORT`, и без этой строки `api` стучится на 8788 в закрытый порт |
| `EB_CORE_TOKEN` | длинная случайная строка (`openssl rand -hex 32`) — общая с `api` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `EMB_MODEL`, … | как в `.env` (см. `.env.example`) |

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
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | `${{core.LLM_BASE_URL}}` и т. д. — модель нужна для резюме заявок |
| `EB_THINKING_PARAM` | `${{core.EB_THINKING_PARAM}}` |
| `PORT` | `8080` — тот же порт, что у домена |

`EB_ENV` не задаётся: без него запуск считается боевым, и API
откажется стартовать без базы, токенов и пределов частоты — это защита, а не помеха.

Схему базы API накатывает сам при старте (миграции вшиты в бинарник), ручных шагов нет.

### 4. Vercel: фронт

Project → Settings:

| Настройка | Значение |
|---|---|
| Root Directory | `web` |
| Git → Production Branch | `main` |
| Environment Variables → `EB_API_URL` | публичный адрес `api` на Railway, `https://….up.railway.app` |
| Environment Variables → `EB_API_TOKEN` | то же значение, что у `api` |
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
| `EB_ALLOWED_ORIGINS` | — | CORS, только для вызовов из браузера напрямую |
| `EB_LIMIT_CHAT_PER_MINUTE` / `_BURST` | 20 / 5 | вопросов с адреса |
| `EB_LIMIT_LEAD_PER_HOUR` / `_BURST` | 10 / 3 | заявок с адреса |
| `EB_LIMIT_FEEDBACK_PER_MINUTE` / `_BURST` | 30 / 10 | оценок с адреса |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | — | модель для резюме заявок; без неё резюме — список вопросов |
| `EB_SUMMARY_TIMEOUT` | `30s` | тайм-аут одного запроса резюме |
