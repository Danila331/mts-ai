-- name: CreateLead :one
INSERT INTO leads (code, name, phone, company, comment, summary, messages)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, created_at;
