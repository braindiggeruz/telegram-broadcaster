-- Additive integration ledger. Rollback: disable LEAD_RADAR_INTEGRATION_ENABLED;
-- preserve this ledger. Never delete accepted/unknown effects to enable retries.
CREATE TABLE IF NOT EXISTS lead_radar_effects (
  owner_id bigint NOT NULL,
  org_id text NOT NULL CHECK (length(org_id) BETWEEN 1 AND 80),
  account_id text NOT NULL,
  account_ref text NOT NULL,
  sender_fingerprint text NOT NULL CHECK (sender_fingerprint ~ '^[a-f0-9]{64}$'),
  effect_id text NOT NULL CHECK (length(effect_id) BETWEEN 8 AND 160),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  random_id text NOT NULL CHECK (random_id ~ '^[1-9][0-9]{0,18}$'),
  recipient text,
  peer_ref text,
  state text NOT NULL CHECK (state IN ('inflight','accepted','rejected','deferred','unknown','cancelled')),
  code text,
  provider_message_id text,
  available_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,org_id,account_id,effect_id),
  UNIQUE(owner_id,random_id),
  CHECK (state <> 'accepted' OR provider_message_id IS NOT NULL),
  CHECK (state <> 'inflight' OR recipient IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS lead_radar_effects_owner_state_idx ON lead_radar_effects(owner_id,state);
CREATE TABLE IF NOT EXISTS lead_radar_peers (
  owner_id bigint NOT NULL,
  org_id text NOT NULL,
  account_id text NOT NULL,
  account_ref text NOT NULL,
  sender_fingerprint text NOT NULL CHECK (sender_fingerprint ~ '^[a-f0-9]{64}$'),
  peer_ref text NOT NULL CHECK (peer_ref ~ '^lrpeer:[a-f0-9]{32}$'),
  peer_digest text NOT NULL CHECK (peer_digest ~ '^[a-f0-9]{64}$'),
  username text NOT NULL,
  peer_secret text NOT NULL CHECK (peer_secret LIKE 'enc:v1:%'),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,org_id,account_id,peer_ref),
  UNIQUE(owner_id,org_id,account_id,sender_fingerprint,peer_digest)
);

CREATE TABLE IF NOT EXISTS lead_radar_session_checks (
 owner_id bigint NOT NULL,sender_fingerprint text NOT NULL CHECK(sender_fingerprint ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz,attempted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,sender_fingerprint)
);
