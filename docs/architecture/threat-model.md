# Модель угроз

Границы доверия и секреты — в [`README.md`](README.md). Здесь — что может пойти не так на каждой границе, чем это
закрыто и где это в коде. «Не сделано» — честно: со ссылкой на задачу `docs/ROADMAP.md`.

STRIDE: **S** — подмена субъекта, **T** — изменение данных, **R** — отказ от авторства, **I** — раскрытие
информации, **D** — отказ в обслуживании, **E** — повышение привилегий.

## STRIDE

| Компонент или поток | | Угроза | Мера | Код |
|---|---|---|---|---|
| Сайт-хозяин ↔ iframe `/embed` | S, T | чужое окно шлёт `eb:ask` или `eb:close` | получатель сверяет `event.origin` и `event.source`; отправка с точным `targetOrigin`, не `*` | `web/widget/loader.ts`, `web/src/app/embed/embed-chat.tsx` |
| то же | S | `/embed` встраивает любой сайт: origin хозяина берётся из `?parent=` | **не сделано:** `frame-ancestors` по allowlist `EB_EMBED_ALLOWED_ORIGINS` — T35 | `web/next.config.ts` (заголовков нет) |
| Браузер → прокси Next | E | посетитель меняет настройки RAG для всех | `POST settings*` только с cookie администратора; без неё — песочница через `overrides` | `web/src/app/api/[...path]/route.ts` (`ADMIN_ONLY`), `web/src/lib/backend.ts` (`isAdmin`) |
| то же | S | кража или подделка сессии администратора | cookie `HttpOnly`, `SameSite=Strict`, `Secure` по HTTPS, 12 ч; в ней HMAC токена, а не токен; смена токена выводит из всех сессий | `web/src/lib/backend.ts` (`adminCookie`, `adminSession`) |
| то же | T, E | обход прокси к другим путям API | список разрешённых путей `ALLOWED`, остальное — 404 | `web/src/app/api/[...path]/route.ts` |
| то же | S, D | подделка адреса в `X-Forwarded-For` и обход пределов | Next берёт первый адрес `X-Forwarded-For` и передаёт его в `X-Client-IP`. Локально (compose) перед Next прокси нет, и этот заголовок задаёт сам клиент; поведение на Vercel тестом **не проверено** — T35 | `web/src/lib/backend.ts` (`clientIp`) |
| Next → Go-API (публичный адрес) | S | прямые запросы к API в обход прокси | `Bearer EB_API_TOKEN`, сравнение за постоянное время; в бою без токена API не стартует | `backend/internal/transport/http/server.go` (`requireToken`), `backend/internal/config/config.go` (`Verify`) |
| то же | S | подмена `X-Client-IP` | заголовку верят только при заданном токене | `server.go` (`clientIP`) |
| то же | E | перебор `EB_ADMIN_TOKEN` | `requireAdmin` за постоянное время; пустой токен закрывает, а не открывает; свой предел `settings` 10/мин | `server.go` (`requireAdmin`, `settingsLimit`); тесты `TestGlobalSettingsNeedAdmin`, `TestSettingsLimit` |
| то же | D | флуд вопросами и заявками | пределы по адресу: чат 20/мин, заявки 10/ч, оценки 30/мин; Redis на все реплики, без него — память; тело ≤ 1 МБ; тайм-аут заголовков 10 с | `server.go` (`limiter`, `MaxBody`), `backend/internal/ratelimit/ratelimit.go` |
| то же | I | CORS открывает API чужим сайтам | CORS выключен, пока `EB_ALLOWED_ORIGINS` пуст | `server.go` |
| Go-API → ядро | S | другая служба приватной сети тратит модель | `Bearer EB_CORE_TOKEN` (`hmac.compare_digest`); ядро не публикуется | `scripts/core_api.py` (`authorized`), `compose.yaml` |
| то же | T, D | диалог-гигант, чужие роли, переопределения за пределами | ≤ 40 реплик по ≤ 4000 символов, тело ≤ 256 000 байт, ключи и пределы `overrides` те же, что у глобальных настроек | `scripts/core_api.py` (`clean_turns`, `Settings.validate`), `backend/internal/dialog/dialog.go` |
| то же | T | песочница одного посетителя меняет ответы другим | переопределения действуют только на свой ответ | `scripts/core_api.py` (`overridden`); тест `TestChatOverridesStayInOwnRequest` |
| Ядро, api → шлюз → провайдер | I | утечка ключа провайдера из ядра или api | ключ провайдера знает только шлюз; у служб свои ключи и списки моделей | `llm-gateway/keys.py`, `compose.yaml` |
| то же | D | счёт за модель | `rpm` и параллельность на ключ (ядро 240/16, api 60/4); бюджет есть, но выключен по умолчанию — без цен `GW_*_PRICE_*` расход нулевой | `llm-gateway/keys.py`, `docs/deploy.md` |
| то же | I | тексты вопросов в базе шлюза | `store_prompts_in_spend_logs: false`, журнал расходов 30 дней | `llm-gateway/config.yaml` |
| Ответ модели → клиент | T | выдуманная цифра, цена, обещание | факты только из базы (промпт); числа ответа сверяются с материалами и диалогом, иначе перезапрос и вырезание; иначе отказ | `energybot/prompts.py` (`RULES`), `energybot/guard.py`, `energybot/pipeline.py` (`check`, `FALLBACK`) |
| то же | T | HTML или скрипт в ответе | ответ выводится как текст React, без `dangerouslySetInnerHTML` и Markdown | `web/src/components/chat/answer-text.tsx` |
| Postgres: заявки, журнал | I | ПДн хранятся вечно или читаются кем угодно | сроки 90/30/90 дней с очисткой; удаление по запросу; роли менеджера и аналитика; порты только на `127.0.0.1` | `backend/internal/privacy/`, `backend/cmd/api/main.go` (`forget`), `backend/scripts/sql/access.sql`, `docs/privacy.md` |
| Журналы служб | I | телефоны в логах | тела запросов не пишутся ни в Go, ни в ядре | `server.go` (`accessLog`), `scripts/core_api.py` (`log_message`) |
| Все службы | R | «я этого не спрашивал», «заявку не оставлял» | `request_id` выдаёт Go-API (или принимает присланный, если он похож на идентификатор), передаёт ядру `X-Request-ID` и пишет в `answers.request_id`, `leads.request_id` | `backend/internal/requestid/`, `backend/migrations/000002_observability.up.sql` |
| Prometheus | I | метрики без ключа | `/metrics` только в приватной сети, ПДн в метриках нет | `monitoring/prometheus.yml.tmpl`, `llm-gateway/config.yaml` |

## OWASP Top 10 for LLM 2025

| Риск | Что сделано и где | Чего нет |
|---|---|---|
| **LLM01 Prompt Injection** | Реплики клиента идут в сообщение `user` под заголовком «ВОПРОС КЛИЕНТА» / «ДИАЛОГ», правила — в `system` (`energybot/prompts.py`, `build_messages`). Правило отвечать на давление спокойно и по базе (`RULES`). У модели нет инструментов: инъекция может изменить только текст ответа, а числа в нём проверяет guard. | Spotlighting (разметка «данные, не инструкции») — T35. Red-team набор `eval/redteam.jsonl` — T35. Клиент присылает всю историю, включая реплики `assistant` (`clean_turns` их принимает): подделать «ответ бота» в истории можно. |
| **LLM02 Sensitive Information Disclosure** | Тела запросов не пишутся в журналы; шлюз не хранит тексты; сроки хранения и `api forget` (`docs/privacy.md`). Модель видит только диалог текущего посетителя — чужих ПДн в промпте нет. | Маскирующий логгер (`slog.Handler` в Go, фильтр в Python) — T35. База знаний целиком открыта на `/kb` и `GET /api/kb` любому посетителю стенда — это сделано для жюри; для боевого запуска решения нет. |
| **LLM03 Supply Chain** | Версии закреплены: `backend/go.sum`, `web/package-lock.json`, `solution-requirements.txt`, образ LiteLLM `1.108.9-lts` (`llm-gateway/Dockerfile`). Зависимости сабмита сверяются с разрешённым набором (`scripts/check_submission.py`). | Dependabot, `govulncheck`, `npm audit`, `pip-audit`, `trivy`, SBOM, actions по SHA — T36. |
| **LLM04 Data and Model Poisoning** | Модель не дообучается (ADR [0001](adr/0001-rag-instead-of-fine-tuning.md)). Источник фактов — только `knowledge-base/` в репозитории; правки — через PR и CI. Диалоги и оценки в обучение и в индекс не попадают. | — |
| **LLM05 Improper Output Handling** | Ответ — простой текст, выводится React без HTML (`web/src/components/chat/answer-text.tsx`). Ответ модели не исполняется и не идёт в SQL (запросы — sqlc, `backend/queries/`). | Allowlist ссылок в ответе — T35 (сейчас ссылок в ответе нет). |
| **LLM06 Excessive Agency** | У модели нет инструментов и доступа к базе. Заявку создаёт только явное действие клиента в форме (`POST /api/lead`). Глобальные настройки — только администратор (T29). | — |
| **LLM07 System Prompt Leakage** | Секретов в промпте нет: ключи и токены живут в окружении служб. Промпт открыт намеренно — вкладка «Промпт» в отладке стенда, поле `prompt` в событии `answer` (`scripts/core_api.py`). | Поле `prompt` уходит и в виджет; отдельного «боевого» режима без отладки нет. |
| **LLM08 Vector and Embedding Weaknesses** | Индекс строится только из `knowledge-base/`; пользовательские тексты в индекс не пишутся. Кеш векторов — по хешу текстов и отпечатку модели: смена модели за псевдонимом не смешает несовместимые векторы (`scripts/index_cache.py`). | — |
| **LLM09 Misinformation** | Факты только из базы, честное «в материалах нет» (`RULES`); guard по числам (`energybot/guard.py`): на 500 верных эталонах против всей базы не срабатывает ни разу, против контекста — в 1,2% (`README.md`); номера источников и сопоставление предложений с разделами (`attribute` в `scripts/core_api.py`); выборка ~500 кейсов с ловушками (`eval/dataset/`). | Метка «ИИ-ассистент, ответы могут быть неточными» — T31. Порог уверенности — T12. |
| **LLM10 Unbounded Consumption** | Пределы частоты в Go; `rpm` и параллельность ключей шлюза; тайм-ауты (`EB_CORE_TIMEOUT` 3 мин, `request_timeout` шлюза 180 с); повторы ограничены (до 3 попыток в клиенте модели ядра `energybot/llm.py` и Go `backend/internal/ai/llm/llm.go`, 0 в шлюзе); ≤ 40 реплик по 4000 символов. | Бюджет шлюза выключен, пока не заданы цены. Дневной потолок токенов на адрес или сессию — T35. Песочница разрешает анонимно поднять `context_chars` до 200 000, `max_tokens` до 8192 и включить размышления (`Settings` в `scripts/core_api.py`) — цена одного ответа растёт в разы, держит только предел 20 вопросов в минуту. |

## Остаточные риски, которые надо закрыть

1. Нет заголовков безопасности: `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` (T35).
2. Доверие к `X-Forwarded-For` в прокси Next не проверено тестом (T35).
3. Нет spotlighting и red-team набора (T35); опасно станет с OCR документов (ADR [0006](adr/0006-vision-only-as-ocr.md)).
4. Песочница поднимает цену ответа без дневного потолка (T35).
5. Нет проверки уязвимостей зависимостей в CI (T36).
6. Длина `EB_ADMIN_TOKEN` (`docs/deploy.md`: «не короче 32 знаков») кодом не проверяется.
