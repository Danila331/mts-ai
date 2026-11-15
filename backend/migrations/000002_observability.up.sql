-- Связь записей с журналом службы и источник резюме заявки.

-- request_id — обращение, в котором дан ответ или принята заявка. По нему
-- строка базы находится в журналах шлюза и ядра. Пусто — запись старше
-- этой миграции.
ALTER TABLE answers ADD COLUMN request_id text NOT NULL DEFAULT '';
ALTER TABLE leads   ADD COLUMN request_id text NOT NULL DEFAULT '';

-- Кто написал резюме: модель или список вопросов клиента. Заявка
-- сохраняется до резюме, и «digest» здесь — это заявки, где модель не
-- ответила: их доля — первый признак, что с моделью что-то не так.
ALTER TABLE leads ADD COLUMN summary_source text NOT NULL DEFAULT 'digest';
ALTER TABLE leads ADD CONSTRAINT leads_summary_source_known CHECK (summary_source IN ('digest', 'llm'));
