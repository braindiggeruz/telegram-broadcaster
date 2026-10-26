-- Pin the approved transport credential without storing the credential in the queue.
ALTER TABLE delivery_campaigns ADD COLUMN IF NOT EXISTS sender_fingerprint text;
