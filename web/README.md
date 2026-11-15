# web — стенд и виджет ИИ-консультанта МТС EnergyTool

Next.js 16 + TypeScript + shadcn/ui. Фронт ходит через прокси `/api/*` в Go-API (`backend/`), а ответы
строит общее ядро `energybot/` во внутренней службе `scripts/core_api.py`. Экраны, протокол виджета и API — в [DESIGN.md](DESIGN.md).

| Адрес | Что это |
|---|---|
| `/playground` | чат с сессиями + отладка ответа (опора, поиск, контекст, промпт, проверка, JSON) |
| `/kb` | база знаний разделами, как их видит модель; `/kb?chunk=<id>` — ссылка на раздел |
| `/widget` | код для вставки на сайт, настройки и живое превью |
| `/embed` | чат внутри iframe виджета |
| `/widget.js` | загрузчик виджета (`widget/loader.ts`, собирается esbuild при `dev` / `build`) |

## Запуск

Из корня репозитория:

```bash
docker compose up --build   # Postgres, ядро и Go-API на :8787, ключи модели — из .env
```

```bash
cd web && npm install && npm run dev  # стенд на http://localhost:3000
```

Сайт МТС со встроенным виджетом (копия сайта в репозиторий не входит — укажите распакованную папку):

```bash
node web/scripts/stand.mjs --site <путь к energytool.mts.ru>   # http://localhost:4000
```

Переменные Next: `EB_API_URL` (адрес Go-API, по умолчанию `http://127.0.0.1:8787`), `EB_API_TOKEN` (общий секрет
с API; локально можно не задавать), `EB_STAND_URL` (ссылка на стенд сайта со страницы `/widget`), `EB_ADMIN_TOKEN` (тот же, что у API: вход
администратора на `/settings`; без него страница работает только песочницей — свои настройки посетителя уходят полем
`overrides` в `/api/chat` и действуют только на его ответы). Заявки, оценки
и журнал ответов хранит Postgres. Без docker — см. [backend/README.md](../backend/README.md); деплой на Vercel и
Railway — [docs/deploy.md](../docs/deploy.md).

## Проверки

```bash
npm run lint && npx tsc --noEmit && npm run build
```
