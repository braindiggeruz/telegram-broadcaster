-- Pending Telegram auth survives request/isolate changes without retaining a
-- live client. All auth material and attempt state are AEAD-encrypted with an
-- owner-bound context; only the expiry needed for database enforcement is clear.
CREATE TABLE IF NOT EXISTS mtproto_pending_auth (
  user_id integer PRIMARY KEY,
  payload_encrypted text NOT NULL CHECK (payload_encrypted LIKE 'enc:v1:%'),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mtproto_pending_auth_expiry ON mtproto_pending_auth(expires_at);
