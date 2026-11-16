-- «Паспорт задачи» (T2): что клиент рассказал о себе и объекте, по полям
-- из чек-листов базы знаний. Паспорт живёт в сессии и копируется в заявку
-- в момент отправки: менеджер видит то, что клиент подтвердил, даже если
-- сессию потом удалят по сроку хранения.
ALTER TABLE sessions ADD COLUMN passport jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Заявка знает свой разговор. NULL — заявка из старой формы или старше
-- этой миграции.
ALTER TABLE leads ADD COLUMN session_id text NULL;
ALTER TABLE leads ADD COLUMN passport jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX leads_session_idx ON leads (session_id);
