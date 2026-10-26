CREATE TABLE IF NOT EXISTS mtproto_auth_controls (
  user_id integer PRIMARY KEY,
  sent_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  next_code_at timestamptz NOT NULL DEFAULT now()
);
