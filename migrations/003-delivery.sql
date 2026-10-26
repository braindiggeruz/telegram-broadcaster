-- Durable immutable campaign snapshots and dispatch state. No Telegram secrets here.
CREATE TABLE IF NOT EXISTS sender_controls (
  sender_key text PRIMARY KEY,
  owner_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bot','mtproto')),
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','COOLDOWN','REVIEW_REQUIRED','AUTH_REQUIRED','DISABLED')),
  cooldown_until timestamptz,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,kind)
);
CREATE TABLE IF NOT EXISTS contact_permissions (
  owner_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bot','mtproto')),
  recipient text NOT NULL,
  allowed boolean NOT NULL,
  source text NOT NULL,
  suppressed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,kind,recipient)
);
CREATE TABLE IF NOT EXISTS delivery_campaigns (
  id bigserial PRIMARY KEY,
  owner_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bot','mtproto')),
  broadcast_id bigint NOT NULL,
  sender_key text NOT NULL REFERENCES sender_controls(sender_key),
  snapshot_hash text NOT NULL,
  message text NOT NULL,
  parse_mode text,
  delay_seconds double precision NOT NULL CHECK (delay_seconds >= 0),
  is_dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','stopping','stopped','completed','review_required','expired','failed')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(owner_id,kind,broadcast_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES delivery_campaigns(id),
  recipient text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','inflight','accepted','dry_run','failed','suppressed','cancelled','expired','unknown')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_id uuid,
  random_id text NOT NULL,
  message_id text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id,recipient)
);
CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries(campaign_id,available_at,id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS delivery_campaigns_worker_idx ON delivery_campaigns(sender_key,scheduled_at,id) WHERE status IN ('queued','running','stopping');
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id bigint NOT NULL REFERENCES deliveries(id),
  state text NOT NULL,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS delivery_attempts_delivery_idx ON delivery_attempts(delivery_id,started_at);
CREATE TABLE IF NOT EXISTS contact_delivery_controls (
  sender_key text NOT NULL REFERENCES sender_controls(sender_key),
  recipient text NOT NULL,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  last_accepted_at timestamptz,
  PRIMARY KEY(sender_key,recipient)
);
CREATE TABLE IF NOT EXISTS delivery_worker_heartbeats (
  worker_id text PRIMARY KEY,
  live_send_enabled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
