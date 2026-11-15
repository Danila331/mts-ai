-- Сессия создаётся на первом вопросе и «трогается» на каждом следующем.
-- Заголовок — первая реплика: следующие вопросы его не перезаписывают.
-- Страница виджета (T8) — последняя присланная: пустой {} её не стирает.
-- Роль (T15) — последняя известная: вопрос без роли (role_source = '')
-- прежнюю не стирает, а выбор клиента, в том числе «не указывать», — да.
-- name: UpsertSession :exec
INSERT INTO sessions (id, channel, mode, title, page, role, role_source)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE
SET updated_at  = now(),
    mode        = EXCLUDED.mode,
    title       = CASE WHEN sessions.title = '' THEN EXCLUDED.title ELSE sessions.title END,
    page        = CASE WHEN EXCLUDED.page = '{}'::jsonb THEN sessions.page ELSE EXCLUDED.page END,
    role        = CASE WHEN EXCLUDED.role_source = '' THEN sessions.role ELSE EXCLUDED.role END,
    role_source = CASE WHEN EXCLUDED.role_source = '' THEN sessions.role_source ELSE EXCLUDED.role_source END;

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
