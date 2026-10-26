CREATE TABLE telegram_subscription_cursors (
  owner_id bigint NOT NULL, recipient text NOT NULL, last_update_id bigint NOT NULL,last_event_date bigint NOT NULL,
  PRIMARY KEY(owner_id,recipient)
);
ALTER TABLE automation_rules ADD COLUMN use_current_audience boolean NOT NULL DEFAULT false;
