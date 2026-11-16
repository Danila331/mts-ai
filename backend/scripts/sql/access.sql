-- Доступ к базе стенда: кто что читает (docs/privacy.md).
--
-- Запускается вручную, один раз и после смены паролей, пользователем-владельцем базы:
--
--   psql "$DATABASE_URL" -v manager_password='…' -v analyst_password='…' -f backend/scripts/sql/access.sql
--
-- Не миграция намеренно: роли и пароли — свойство конкретного сервера (на Railway и локально они разные),
-- а миграции api накатывает одинаково везде. Скрипт идемпотентен — повторный запуск приводит права к
-- описанному здесь.
--
-- Роли:
--   energytool_manager  — менеджер: заявки целиком (ему звонить), больше ничего.
--   energytool_analyst  — разбор качества: ответы и оценки без телефонов и почты, заявки без контактов.
-- Служба api ходит под владельцем базы и в эти роли не входит.

\set ON_ERROR_STOP on

BEGIN;

-- Новые таблицы схемы public не должны становиться видны всем, кто может подключиться.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Роли: создать, если нет, и выставить пароль.
SELECT format('CREATE ROLE %I LOGIN', r)
FROM unnest(ARRAY['energytool_manager', 'energytool_analyst']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec
ALTER ROLE energytool_manager WITH LOGIN PASSWORD :'manager_password' CONNECTION LIMIT 5;
ALTER ROLE energytool_analyst WITH LOGIN PASSWORD :'analyst_password' CONNECTION LIMIT 5;

-- Начать с нуля: права ниже — единственные.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM energytool_manager, energytool_analyst;

-- Менеджер: заявки и разговоры клиентов (сессии и их реплики), только чтение.
GRANT USAGE ON SCHEMA public TO energytool_manager;
GRANT SELECT ON leads, sessions, session_messages, answers TO energytool_manager;

-- Аналитик: представления без контактов в отдельной схеме.
CREATE SCHEMA IF NOT EXISTS analytics;
REVOKE ALL ON SCHEMA analytics FROM PUBLIC;

-- Телефоны (от 10 цифр с разделителями) и адреса почты в свободном тексте заменяются метками.
CREATE OR REPLACE FUNCTION analytics.mask_pii(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(coalesce(t, ''), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[почта]', 'g'),
           '\+?\d[\d\s\-().]{8,}\d', '[телефон]', 'g')
$$;

CREATE OR REPLACE VIEW analytics.answers AS
SELECT id, request_id, mode, analytics.mask_pii(question) AS question, analytics.mask_pii(answer) AS answer,
       fallback, error, model, turns, timings, guard, created_at, session_id, sources
FROM public.answers;

-- Сессии без заголовка: заголовок — первая реплика клиента.
CREATE OR REPLACE VIEW analytics.sessions AS
SELECT id, channel, mode, created_at, updated_at
FROM public.sessions;

CREATE OR REPLACE VIEW analytics.feedback AS
SELECT id, session_id, message_id, rating, analytics.mask_pii(comment) AS comment,
       analytics.mask_pii(question) AS question, analytics.mask_pii(answer) AS answer, created_at
FROM public.feedback;

-- Заявки без имени, телефона, компании, комментария и диалога: сколько, когда и кто писал резюме.
CREATE OR REPLACE VIEW analytics.leads AS
SELECT id, code, summary_source, request_id, created_at
FROM public.leads;

GRANT USAGE ON SCHEMA analytics TO energytool_analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO energytool_analyst;
GRANT EXECUTE ON FUNCTION analytics.mask_pii(text) TO energytool_analyst;

COMMIT;
