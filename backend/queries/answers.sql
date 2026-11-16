-- Повтор того же id — это повтор доставки, а не второй ответ: ядро
-- выдаёт id один раз. Первая запись остаётся.
-- name: SaveAnswer :exec
INSERT INTO answers (id, mode, question, answer, fallback, error, model, turns, timings, guard, request_id, session_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (id) DO NOTHING;
