# backend — Go-API стенда и виджета EnergyTool

Публичный API, в который ходит фронт (`web/`, через прокси `/api/*`). Ответ на вопрос строит Python-ядро
(`scripts/core_api.py`, код `energybot/` не дублируется); здесь — всё остальное: приём запросов, поток ответа,
заявки, оценки, журнал ответов в Postgres, пределы частоты и токен прокси.

Контракт — тот же, что был у Python-API (`web/src/lib/types.ts`): фронт переезда не заметил.

| Метод | Что делает |
|---|---|
| `GET /healthz` | проба хостинга: процесс жив, база отвечает (без токена) |
| `GET /api/health` | состояние ядра как есть + `db` |
| `GET /api/kb` | база знаний разделами — байт в байт как у ядра |
| `POST /api/chat` `{messages, mode}` | SSE ядра насквозь: `stage` → `stage` → `answer` → `done`; ответ ложится в `answers` |
| `POST /api/lead` | заявка с резюме модели (без модели — список вопросов) и оценкой правилами (`leads.score`: hot/warm/cold, причины, что спросить) → `leads`; ответ `{id, summary}` — оценку клиент не видит |
| `POST /api/feedback` | 👍/👎 → `feedback` |
| `GET /api/settings` | настройки RAG ядра: текущие, из окружения, пределы |
| `POST /api/settings` | `{"values": {...}}` — глобально, до перезапуска ядра; проверяет ядро |
| `POST /api/settings/reset` | вернуть значения из окружения |

Ошибки — `{"error": "…"}`: так их читает фронт.

## Устройство

```
cmd/api/main.go                 сборка зависимостей, миграции, запуск и остановка
internal/
  config/                       файл + окружение (cleanenv), Verify для боя
  logger/                       zerolog: уровень, формат, service/version в каждой строке
  requestid/                    сквозной id обращения: журнал, ядро, база
  metrics/                      Prometheus на отдельном порту
  ratelimit/                    пределы частоты: Redis на все реплики, память — запасной путь
  apperr/                       отказ клиенту (400) отдельно от поломки (500)
  dialog/                       предмет: реплики, их чистка, пересказ
  chat/        chat/usecase/    ответ: поток ядра → клиенту, ответ → журнал
  lead/        lead/usecase/    заявка: контакты, резюме моделью, номер
  lead/score/                   оценка заявки правилами с причинами и «что спросить» (ADR 0005)
  feedback/    feedback/usecase/ оценка
  health/                       живость для хостинга и состояние для фронта
  core/                         адаптер: HTTP-клиент ядра и разбор SSE
  ai/llm/                       адаптер: OpenAI-совместимый клиент модели (в стенде — через llm-gateway)
  storage/postgres/             адаптер: пул, миграции, репозитории; db/ — код sqlc
  transport/http/               echo: маршруты, токен, пределы, SSE
migrations/                     схема (вшита в бинарник через embed)
queries/                        SQL для sqlc
```

Зависимости идут внутрь: транспорт → usecase → предмет. Usecase объявляют нужные им порты интерфейсами
(`Journal`, `Repository`, `Summarizer`), адаптеры (`core`, `llm`, `postgres`) их реализуют, а
`cmd/api` собирает одно с другим. Адаптеры зависят только от предмета: форма потока ядра (`chat.Stream`)
и занятый номер заявки (`lead.ErrCodeTaken`) объявлены в нём, а порт модели говорит словами сценария
(`Complete(system, user)`), а не форматом сообщений OpenAI.

## Журнал, метрики, остановка

- **Журнал** — zerolog: JSON в бою, текст на машине разработчика (`EB_LOG_FORMAT`, `EB_LOG_LEVEL`). В каждой
  строке `service` и `version`; у строк запроса — `request_id`. Он же уходит в ядро заголовком `X-Request-ID`,
  в ответ клиенту и в колонку `request_id` журнала ответов и заявок. Контакты и тела запросов не пишутся.
- **Метрики** — `:9091/metrics` (`EB_METRICS_PORT`, `0` — выкл.): запросы по маршрутам, длительность,
  открытые потоки, исходы ответов (`answered`/`fallback`/`core_error`/`broken`/`empty`), заявки по источнику
  резюме, отказы по пределам, сбои Redis.
- **Пределы** — в Redis (`EB_REDIS_URL`/`REDIS_URL`), общие для всех реплик; Redis недоступен — пределы
  считаются в памяти реплики, клиентам не отказывают.
- **Заявка** сохраняется до резюме моделью: база недоступна — модель не зовётся; модель недоступна — заявка
  уже лежит со списком вопросов (`summary_source = digest`).
- **Персональные данные** — срок хранения заявок, журнала ответов и оценок (`EB_RETENTION_*`, очистка в фоне
  раз в час), удаление по запросу (`api forget -phone … -yes`), роли доступа (`scripts/sql/access.sql`).
  Подробности — [docs/privacy.md](../docs/privacy.md).
- **Остановка** ждёт текущие ответы до `EB_CORE_TIMEOUT` + 15 с (`EB_SHUTDOWN_TIMEOUT`). Поток, пока ядро
  думает, раз в `EB_SSE_HEARTBEAT` получает комментарий `: ping` — прокси не рвут тихое соединение.

## Запуск

Всё в docker — из корня репозитория:

```bash
docker compose up --build        # весь стенд (compose.yaml): web :3000, API :8787, метрики :9091, Postgres :5433
```

Без docker (нужны Go 1.25+ и Postgres):

```bash
make -C backend db-up            # только база в docker — или свой Postgres на :5433
make -C backend core             # ядро на :8788 из .venv
make -C backend api              # API на :8787, ключи — из ../.env
```

## Проверки

```bash
make -C backend lint test        # gofmt, vet, тесты (хранилище пропускается без базы)
make -C backend test-db          # те же тесты против живого Postgres
make -C backend sqlc             # после правки queries/ или migrations/
sh backend/scripts/smoke.sh http://127.0.0.1:8787 [EB_API_TOKEN]   # сквозная проверка поднятого стенда
```

Деплой на Railway и связка с Vercel — [docs/deploy.md](../docs/deploy.md).
