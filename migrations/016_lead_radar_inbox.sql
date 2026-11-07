-- Replies are collected only for peers with a confirmed accepted Lead Radar effect.
CREATE TABLE IF NOT EXISTS lead_radar_inbox_cursors (
 owner_id bigint NOT NULL,org_id text NOT NULL,account_id text NOT NULL,sender_fingerprint text NOT NULL,
 peer_ref text NOT NULL,last_message_id bigint NOT NULL CHECK(last_message_id>0),
 poll_after timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,org_id,account_id,sender_fingerprint,peer_ref)
);
CREATE TABLE IF NOT EXISTS lead_radar_inbox_outbox (
 owner_id bigint NOT NULL,org_id text NOT NULL,account_id text NOT NULL,event_id text NOT NULL,
 effect_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('reply','opt_out')),
 payload_secret text,payload_sha256 text NOT NULL,occurred_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','expired','conflict')),
 attempt_count integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,org_id,account_id,event_id),
 CHECK(payload_secret IS NULL OR payload_secret LIKE 'enc:v1:%')
);
CREATE INDEX IF NOT EXISTS lead_radar_inbox_pending_idx ON lead_radar_inbox_outbox(next_attempt_at) WHERE state='pending';
