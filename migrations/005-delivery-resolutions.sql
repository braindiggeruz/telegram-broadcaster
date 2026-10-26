CREATE TABLE IF NOT EXISTS delivery_resolutions (
  id bigserial PRIMARY KEY,
  delivery_id bigint NOT NULL REFERENCES deliveries(id),
  owner_id bigint NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('accepted','cancelled')),
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
