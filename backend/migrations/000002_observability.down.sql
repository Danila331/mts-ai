ALTER TABLE leads DROP CONSTRAINT leads_summary_source_known;
ALTER TABLE leads DROP COLUMN summary_source;
ALTER TABLE leads DROP COLUMN request_id;
ALTER TABLE answers DROP COLUMN request_id;
