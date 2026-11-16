-- Привязка ответов и заявок к диалогу для честной воронки, без фиктивного resolution_rate.
ALTER TABLE answers ADD COLUMN session_id text NOT NULL DEFAULT '';
CREATE INDEX answers_session_idx ON answers (session_id, created_at);

ALTER TABLE leads ADD COLUMN session_id text NOT NULL DEFAULT '';
CREATE INDEX leads_session_idx ON leads (session_id);
