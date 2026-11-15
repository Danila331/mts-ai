-- name: CreateLead :one
INSERT INTO leads (code, name, phone, company, comment, summary, summary_source, messages, request_id,
                   session_id, passport, score, callback_preference)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, created_at;

-- Резюме моделью приходит после записи заявки и заменяет список вопросов.
-- name: UpdateLeadSummary :execrows
UPDATE leads SET summary = $2, summary_source = $3 WHERE id = $1;
