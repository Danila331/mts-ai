-- Тип заявки (T17): не только «перезвоните». Все четыре типа описаны в
-- базе знаний: обратный звонок и бесплатная предварительная оценка
-- (00-reference/03-calculation-and-requests.md) — для всех продуктов;
-- демо-кабинет и пилотное подключение «один прибор из пяти»
-- (20-products/22-askue.md, «Как посмотреть до покупки») — только для
-- платформы учёта. Какой тип годится какому продукту, решает сервис
-- (internal/lead, KindsFor); база держит только список.
-- Старые заявки — обратный звонок: другого пути тогда не было.
ALTER TABLE leads ADD COLUMN kind text NOT NULL DEFAULT 'callback';
ALTER TABLE leads ADD CONSTRAINT leads_kind_ck CHECK (kind IN ('callback', 'assessment', 'demo', 'pilot'));
CREATE INDEX leads_kind_idx ON leads (kind, created_at DESC);
