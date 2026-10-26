-- Refuse ambiguous duplicate legacy credentials until explicitly reconciled.
ALTER TABLE bot_settings ALTER COLUMN "botToken" TYPE text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_settings_user_unique ON bot_settings ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS mtproto_sessions_user_unique ON mtproto_sessions ("userId");

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  bucket_key text PRIMARY KEY,
  attempts integer NOT NULL,
  window_started_at timestamptz NOT NULL
);
