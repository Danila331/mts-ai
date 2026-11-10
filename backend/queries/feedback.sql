-- name: CreateFeedback :exec
INSERT INTO feedback (session_id, message_id, rating, comment, question, answer)
VALUES ($1, $2, $3, $4, $5, $6);
