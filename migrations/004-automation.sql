CREATE TABLE campaign_snapshots (
  owner_id integer NOT NULL, kind text NOT NULL CHECK(kind IN ('bot','mtproto')),
  broadcast_id integer NOT NULL, request_key text NOT NULL,
  recipients jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,kind,broadcast_id), UNIQUE(owner_id,kind,request_key)
);
CREATE TABLE message_drafts (
  owner_id integer NOT NULL, key text NOT NULL, message text NOT NULL,
  parse_mode text NOT NULL, version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,key)
);
CREATE TABLE automation_rules (
  id serial PRIMARY KEY, owner_id integer NOT NULL, name text NOT NULL,
  transport text NOT NULL CHECK(transport IN ('bot','mtproto')),
  list_id integer NOT NULL, recipients jsonb NOT NULL, message text NOT NULL,
  parse_mode text NOT NULL, delay_seconds real NOT NULL,
  is_dry_run boolean NOT NULL DEFAULT true,
  trigger text NOT NULL CHECK(trigger IN ('schedule','webhook')),
  interval_minutes integer CHECK(interval_minutes>=5),
  max_runs_per_day integer NOT NULL DEFAULT 24 CHECK(max_runs_per_day BETWEEN 1 AND 288),
  webhook_hash text, enabled boolean NOT NULL DEFAULT true, archived boolean NOT NULL DEFAULT false,
  next_run_at timestamptz, last_run_at timestamptz,
  approved_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_events (
  id bigserial PRIMARY KEY, rule_id integer NOT NULL REFERENCES automation_rules(id),
  owner_id integer NOT NULL, event_key text NOT NULL, status text NOT NULL DEFAULT 'pending',
  broadcast_id integer, detail text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id,event_key)
);
CREATE INDEX automation_pending ON automation_events(status,created_at);
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, owner_id integer NOT NULL, action text NOT NULL,
  target text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
