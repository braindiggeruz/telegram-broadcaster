-- Legacy columns stored local database wall time. Interpret them in the
-- migration connection's TimeZone, then retain an absolute instant from now on.
-- Review the original database TimeZone before adopting a legacy deployment.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT table_name,column_name
    FROM information_schema.columns
    WHERE table_schema=current_schema()
      AND table_name IN ('users','bot_settings','recipient_lists','broadcasts',
                        'broadcast_logs','mtproto_sessions','mtproto_broadcasts',
                        'mtproto_broadcast_logs')
      AND data_type='timestamp without time zone'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE current_setting(''TimeZone'')',
      current_schema(),item.table_name,item.column_name,item.column_name);
  END LOOP;
END $$;
