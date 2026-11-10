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
| `POST /api/lead` | заявка с резюме модели (без модели — список вопросов) → `leads`; ответ `{id, summary}` |
| `POST /api/feedback` | 👍/👎 → `feedback` |

Ошибки — `{"error": "…"}`: так их читает фронт.

## Устройство

```
cmd/api/main.go                 сборка зависимостей, миграции, запуск и остановка
internal/
  config/                       файл + окружение (cleanenv), Verify для боя
  apperr/                       отказ клиенту (400) отдельно от поломки (500)
  dialog/                       предмет: реплики, их чистка, пересказ
  chat/        chat/usecase/    ответ: поток ядра → клиенту, ответ → журнал
  lead/        lead/usecase/    заявка: контакты, резюме моделью, номер
  feedback/    feedback/usecase/ оценка
  health/                       живость для хостинга и состояние для фронта
  core/                         адаптер: HTTP-клиент ядра и разбор SSE
  ai/llm/                       адаптер: OpenAI-совместимый клиент модели
  storage/postgres/             адаптер: пул, миграции, репозитории; db/ — код sqlc
  transport/http/               echo: маршруты, токен, пределы, SSE
migrations/                     схема (вшита в бинарник через embed)
queries/                        SQL для sqlc
```

Зависимости идут внутрь: транспорт → usecase → предмет. Usecase объявляют нужные им порты интерфейсами
(`Core`, `Journal`, `Repository`, `Summarizer`), адаптеры (`core`, `llm`, `postgres`) их реализуют, а
`cmd/api` собирает одно с другим.

## Запуск

Всё в docker — из корня репозитория:

```bash
docker compose up --build        # Postgres :5433, ядро, API :8787
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
