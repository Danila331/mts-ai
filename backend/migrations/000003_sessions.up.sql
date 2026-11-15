-- Сессии диалогов: пункт 5 кейса — «сохраняйте историю всех диалоговых
-- сессий, включая разговоры без заявки». До этой миграции диалог жил
-- только в localStorage браузера, а журнал ответов не знал, какие ответы
-- — один разговор.
--
-- id — id сессии фронта: «Новый диалог» создаёт новый, и сервер видит
-- ровно те разговоры, что и клиент. title — первая реплика клиента, то
-- есть его же текст: срок хранения и удаление по номеру у сессий те же,
-- что у журнала ответов (internal/privacy).
CREATE TABLE sessions (
    id         text PRIMARY KEY,
    channel    text        NOT NULL DEFAULT 'playground',
    mode       text        NOT NULL DEFAULT 'chat',
    title      text        NOT NULL DEFAULT '',
    -- Страница, с которой открыт виджет (url, title, utm) — заполняет T8.
    page       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sessions_channel_known CHECK (channel IN ('playground', 'embed', 'telegram'))
);

-- Экран менеджера и очистка по сроку идут от последних разговоров.
CREATE INDEX sessions_recent_idx ON sessions (updated_at DESC);

-- Ответ знает свою сессию. NULL — ответ старше этой миграции или от
-- клиента, который сессию не прислал. Внешнего ключа нет намеренно: сбой
-- записи сессии не должен стоить записи ответа.
ALTER TABLE answers ADD COLUMN session_id text NULL;
CREATE INDEX answers_session_idx ON answers (session_id, created_at);

-- На какие разделы базы опирался ответ: id из citations ядра, без текста —
-- текст раздела есть в базе знаний.
ALTER TABLE answers ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb;
