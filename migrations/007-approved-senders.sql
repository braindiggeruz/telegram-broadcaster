ALTER TABLE campaign_snapshots ADD COLUMN sender_fingerprint text;
ALTER TABLE automation_rules ADD COLUMN sender_fingerprint text;
ALTER TABLE automation_rules ADD COLUMN request_key text;
ALTER TABLE automation_rules ADD COLUMN request_hash text;
ALTER TABLE automation_rules ADD COLUMN webhook_secret text;
CREATE UNIQUE INDEX automation_request_unique ON automation_rules(owner_id,request_key) WHERE request_key IS NOT NULL;
