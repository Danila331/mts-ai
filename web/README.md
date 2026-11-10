# web — стенд и виджет ИИ-консультанта МТС EnergyTool

Next.js 16 + TypeScript + shadcn/ui. Ответы строит общее ядро `energybot/` через `scripts/web_api.py`;
фронт ходит в него через прокси `/api/*`. Экраны, протокол виджета и API — в [DESIGN.md](DESIGN.md).

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
.venv/bin/python scripts/web_api.py   # API на :8787, ключи модели — из .env
```

```bash
cd web && npm install && npm run dev  # стенд на http://localhost:3000
```

Сайт МТС со встроенным виджетом (копия сайта в репозиторий не входит — укажите распакованную папку):

```bash
node web/scripts/stand.mjs --site <путь к energytool.mts.ru>   # http://localhost:4000
```

Переменные: `EB_API_URL` (адрес Python-API для Next, по умолчанию `http://127.0.0.1:8787`), `EB_STAND_URL`
(ссылка на стенд сайта со страницы `/widget`), `EB_WEB_PORT` / `EB_WEB_HOST` / `EB_WEB_CORS` / `EB_WEB_MODE`
для `web_api.py`. Заявки и оценки ответов пишутся в `web/.data/` (в git не попадают, данные только тестовые).

## Проверки

```bash
npm run lint && npx tsc --noEmit && npm run build
```
