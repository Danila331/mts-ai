-- Сессия создаётся на первом вопросе и «трогается» на каждом следующем.
-- Заголовок — первая реплика: следующие вопросы его не перезаписывают.
-- Страница виджета (T8) — последняя присланная: пустой {} её не стирает.
-- Роль (T15) — последняя известная: вопрос без роли (role_source = '')
-- прежнюю не стирает, а выбор клиента, в том числе «не указывать», — да.
-- Уровень объяснения (T16) пишется, только если клиент его прислал
-- (level_set): пустой уровень при level_set — «обычный», стирает прежний.
-- name: UpsertSession :exec
INSERT INTO sessions (id, channel, mode, title, page, role, role_source, level)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO UPDATE
SET updated_at  = now(),
    mode        = EXCLUDED.mode,
    title       = CASE WHEN sessions.title = '' THEN EXCLUDED.title ELSE sessions.title END,
    page        = CASE WHEN EXCLUDED.page = '{}'::jsonb THEN sessions.page ELSE EXCLUDED.page END,
    role        = CASE WHEN EXCLUDED.role_source = '' THEN sessions.role ELSE EXCLUDED.role END,
    role_source = CASE WHEN EXCLUDED.role_source = '' THEN sessions.role_source ELSE EXCLUDED.role_source END,
    level       = CASE WHEN sqlc.arg(level_set)::boolean THEN EXCLUDED.level ELSE sessions.level END;

-- name: GetSession :one
SELECT id, channel, mode, title, page, passport, role, role_source, level, created_at, updated_at
FROM sessions WHERE id = $1;

-- Реплики сессии по порядку: каждая строка журнала — вопрос клиента и ответ.
-- name: SessionAnswers :many
SELECT id, question, answer, fallback, mode, sources, created_at
FROM answers
WHERE session_id = $1
ORDER BY created_at, id;

-- Паспорт читается и пишется целиком: поля сливает предмет (internal/passport),
-- а не SQL. Строки нет — сессии нет.
-- name: GetPassport :one
SELECT passport FROM sessions WHERE id = $1;

-- name: SavePassport :execrows
UPDATE sessions SET passport = $2, updated_at = now() WHERE id = $1;

-- Переписка сессии (000009). Запись реплик идёт под блокировкой сессии:
-- два вопроса одного разговора подряд не должны получить один seq.
-- name: LockSessionMessages :exec
SELECT pg_advisory_xact_lock(hashtext('energytool:messages:' || @session_id::text));

-- name: LastSessionMessage :one
SELECT role, content FROM session_messages WHERE session_id = $1 ORDER BY seq DESC LIMIT 1;

-- Нет сессии — нет и строки: реплика не должна ронять запись ответа.
-- Переписку ведёт только чат клиента: режим сессии — режим последнего
-- вопроса, копилот менеджера в неё не пишет.
-- name: AddSessionMessage :exec
INSERT INTO session_messages (session_id, seq, role, content, answer_id)
SELECT s.id,
       (SELECT COALESCE(max(m.seq), 0) + 1 FROM session_messages m WHERE m.session_id = s.id),
       @role::text, @content::text, sqlc.narg(answer_id)::text
FROM sessions s WHERE s.id = @session_id::text AND s.mode = 'chat';

-- name: SessionMessages :many
SELECT m.role, m.content, m.answer_id, m.created_at,
       COALESCE(a.sources, '[]'::jsonb) AS sources, COALESCE(a.fallback, false)::boolean AS fallback
FROM session_messages m
LEFT JOIN answers a ON a.id = m.answer_id
WHERE m.session_id = $1
ORDER BY m.seq;

-- Заявка сессии (последняя): номер и тип для списка диалогов и карточки.
-- name: SessionLead :one
SELECT code, kind FROM leads WHERE session_id = $1 ORDER BY created_at DESC, id LIMIT 1;

-- Список диалогов менеджера: чат клиентов, новые сверху. Число реплик —
-- из переписки, а у сессий старше 000009 — две на каждый ответ журнала.
-- name: ListSessions :many
SELECT s.id, s.channel, s.title, s.role, s.passport, s.created_at, s.updated_at,
       CASE WHEN mc.n > 0 THEN mc.n ELSE 2 * ac.n END::int AS message_count,
       COALESCE(l.code, '')::text AS lead_code,
       COALESCE(l.kind, '')::text AS lead_kind
FROM sessions s
CROSS JOIN LATERAL (SELECT count(*) AS n FROM session_messages m WHERE m.session_id = s.id) mc
CROSS JOIN LATERAL (SELECT count(*) AS n FROM answers a WHERE a.session_id = s.id) ac
LEFT JOIN LATERAL (
    SELECT code, kind FROM leads WHERE session_id = s.id ORDER BY created_at DESC, id LIMIT 1
) l ON true
WHERE s.mode = 'chat'
ORDER BY s.updated_at DESC, s.id
LIMIT @row_limit OFFSET @row_offset;

-- name: CountSessions :one
SELECT count(*) FROM sessions WHERE mode = 'chat';
