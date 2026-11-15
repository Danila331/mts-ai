-- Сессия создаётся на первом вопросе и «трогается» на каждом следующем.
-- Заголовок — первая реплика: следующие вопросы его не перезаписывают.
-- name: UpsertSession :exec
INSERT INTO sessions (id, channel, mode, title)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO UPDATE
SET updated_at = now(),
    mode       = EXCLUDED.mode,
    title      = CASE WHEN sessions.title = '' THEN EXCLUDED.title ELSE sessions.title END;

-- name: GetSession :one
SELECT id, channel, mode, title, page, passport, created_at, updated_at FROM sessions WHERE id = $1;

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
