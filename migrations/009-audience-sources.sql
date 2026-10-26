CREATE TABLE audience_sources (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL,
  list_id integer NOT NULL,
  name text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('bot','mtproto')),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  secret_hash text NOT NULL,
  encrypted_secret text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  UNIQUE(owner_id,request_key)
);
CREATE INDEX audience_sources_owner_list ON audience_sources(owner_id,list_id);
CREATE TABLE audience_source_events (
  id bigserial PRIMARY KEY,
  source_id integer NOT NULL REFERENCES audience_sources(id),
  event_key text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,event_key)
);
CREATE TABLE audience_source_members (
  source_id integer NOT NULL REFERENCES audience_sources(id),
  recipient text NOT NULL,
  declared_subscription boolean NOT NULL,
  consent_at timestamptz,
  last_event_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,recipient)
);
