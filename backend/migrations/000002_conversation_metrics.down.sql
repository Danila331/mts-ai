DROP INDEX IF EXISTS leads_session_idx;
ALTER TABLE leads DROP COLUMN session_id;

DROP INDEX IF EXISTS answers_session_idx;
ALTER TABLE answers DROP COLUMN session_id;
