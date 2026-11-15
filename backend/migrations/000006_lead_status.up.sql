-- Статус заявки на экране менеджера (T5): новая → в работе → закрыта или
-- нецелевая. Это же разметка качества для пилота (T40): «нецелевая» —
-- заявка, которая не должна была дойти до менеджера.
--
-- Значения латиницей, подписи — в internal/lead (Status). Все заявки до
-- миграции — новые.
ALTER TABLE leads ADD COLUMN status text NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD CONSTRAINT leads_status_ck CHECK (status IN ('new', 'in_progress', 'done', 'rejected'));
-- NULL — статус ни разу не меняли.
ALTER TABLE leads ADD COLUMN status_changed_at timestamptz NULL;
CREATE INDEX leads_status_idx ON leads (status, created_at DESC);
