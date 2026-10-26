CREATE TABLE IF NOT EXISTS message_media (
  id uuid PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png')),
  size integer NOT NULL CHECK (size > 0 AND size <= 1048576),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content_encrypted text NOT NULL CHECK (content_encrypted LIKE 'enc:v1:%' AND octet_length(content_encrypted) <= 1900000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,sha256)
);
ALTER TABLE message_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE message_media FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON TABLE message_media FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON TABLE message_media FROM authenticated; END IF;
END $$;

ALTER TABLE mtproto_broadcasts ADD COLUMN IF NOT EXISTS "photoId" uuid REFERENCES message_media(id);
ALTER TABLE mtproto_broadcasts ADD COLUMN IF NOT EXISTS photo_sha256 text;
ALTER TABLE delivery_campaigns ADD COLUMN IF NOT EXISTS photo_id uuid REFERENCES message_media(id);
ALTER TABLE delivery_campaigns ADD COLUMN IF NOT EXISTS photo_sha256 text;
ALTER TABLE message_drafts ADD COLUMN IF NOT EXISTS photo_id uuid REFERENCES message_media(id);

CREATE INDEX IF NOT EXISTS mtproto_broadcasts_photo_idx ON mtproto_broadcasts("photoId") WHERE "photoId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_campaigns_photo_idx ON delivery_campaigns(photo_id) WHERE photo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_drafts_photo_idx ON message_drafts(photo_id) WHERE photo_id IS NOT NULL;
