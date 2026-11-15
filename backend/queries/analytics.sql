-- Аналитика воронки и пробелов базы (T6): два агрегатных запроса.

-- Воронка по сессиям, созданным с @since: сессии → с ответом → паспорт
-- заполнен хотя бы на @min_fields полей (контакты клиента не в счёт) →
-- с заявкой. Срезы: заявки по оценке и типу, сессии и заявки по каналу.
-- name: AnalyticsSummary :one
WITH s AS (
    SELECT id, channel,
           EXISTS (SELECT 1 FROM answers a WHERE a.session_id = sessions.id) AS answered,
           (SELECT count(*) FROM jsonb_object_keys(sessions.passport->'values') AS k
             WHERE k <> ALL (@contact_keys::text[])) >= @min_fields::int AS filled,
           EXISTS (SELECT 1 FROM leads l WHERE l.session_id = sessions.id) AS has_lead
    FROM sessions
    WHERE sessions.created_at >= @since
), l AS (
    SELECT l.kind, COALESCE(NULLIF(l.score->>'grade', ''), 'unscored') AS grade,
           COALESCE(s.channel, 'unknown') AS channel
    FROM leads l LEFT JOIN sessions s ON s.id = l.session_id
    WHERE l.created_at >= @since
), a AS (
    SELECT fallback FROM answers WHERE answers.created_at >= @since
)
SELECT
    (SELECT count(*) FROM s)                          AS sessions,
    (SELECT count(*) FROM s WHERE answered)           AS answered,
    (SELECT count(*) FROM s WHERE filled)             AS filled,
    (SELECT count(*) FROM s WHERE has_lead)           AS with_lead,
    (SELECT count(*) FROM l)                          AS leads,
    (SELECT count(*) FROM a)                          AS answers,
    (SELECT count(*) FROM a WHERE fallback)           AS fallbacks,
    COALESCE((SELECT jsonb_object_agg(grade, n) FROM (SELECT grade, count(*) AS n FROM l GROUP BY grade) g), '{}'::jsonb)::jsonb AS by_grade,
    COALESCE((SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) AS n FROM l GROUP BY kind) g), '{}'::jsonb)::jsonb AS by_kind,
    COALESCE((SELECT jsonb_object_agg(channel, n) FROM (SELECT channel, count(*) AS n FROM s GROUP BY channel) g), '{}'::jsonb)::jsonb AS sessions_by_channel,
    COALESCE((SELECT jsonb_object_agg(channel, n) FROM (SELECT channel, count(*) AS n FROM l GROUP BY channel) g), '{}'::jsonb)::jsonb AS leads_by_channel;

-- Пробелы базы: вопросы, на которые бот дал запасной ответ. Уверенность
-- ответа в журнале не хранится, поэтому признак один — fallback. Тексты
-- без телефонов и почты: те же правила, что у analytics.mask_pii в
-- scripts/sql/access.sql, продублированы здесь, потому что функция живёт
-- только там, где этот скрипт запускали.
-- name: AnalyticsGaps :many
SELECT min(q)::text AS question, count(*) AS n, max(created_at)::timestamptz AS last_at
FROM (
    SELECT created_at,
           left(btrim(regexp_replace(
                   regexp_replace(question, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[почта]', 'g'),
                   '\+?\d[\d\s\-().]{8,}\d', '[телефон]', 'g')), 300) AS q
    FROM answers
    WHERE fallback AND created_at >= @since
) m
WHERE q <> ''
GROUP BY lower(q)
ORDER BY n DESC, last_at DESC
LIMIT @row_limit;
