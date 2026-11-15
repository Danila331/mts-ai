-- name: CreateLead :one
INSERT INTO leads (code, name, phone, company, comment, summary, summary_source, messages, request_id,
                   session_id, passport, score, callback_preference, kind)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
RETURNING id, created_at;

-- Резюме моделью приходит после записи заявки и заменяет список вопросов.
-- name: UpdateLeadSummary :execrows
UPDATE leads SET summary = $2, summary_source = $3 WHERE id = $1;

-- Экран менеджера (T5). Список — новые сверху; статус '' — все.
-- name: ListLeads :many
SELECT code, created_at, name, company, kind, status, status_changed_at,
       COALESCE(score->>'grade', '')::text   AS grade,
       COALESCE(score->>'product', '')::text AS product
FROM leads
WHERE (@status::text = '' OR status = @status::text)
ORDER BY created_at DESC, id
LIMIT @row_limit OFFSET @row_offset;

-- name: CountLeads :one
SELECT count(*) FROM leads WHERE (@status::text = '' OR status = @status::text);

-- name: GetLeadByCode :one
SELECT id, code, name, phone, company, comment, summary, summary_source, messages, created_at,
       session_id, passport, score, callback_preference, kind, status, status_changed_at
FROM leads WHERE code = $1;

-- name: SetLeadStatus :one
UPDATE leads SET status = $2, status_changed_at = now() WHERE code = $1
RETURNING status_changed_at;
