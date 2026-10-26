-- Apply only to a dedicated TG Sender Supabase project after app migrations.
-- The app uses server-side PostgreSQL credentials; it does not expose its tables
-- through Supabase's anonymous/authenticated Data API roles.
BEGIN;
DO $$
DECLARE relation record;
BEGIN
  IF to_regclass('public.app_migrations') IS NULL
     OR to_regclass('public.delivery_campaigns') IS NULL THEN
    RAISE EXCEPTION 'TG_SENDER_SCHEMA_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    RAISE EXCEPTION 'SUPABASE_ROLES_REQUIRED';
  END IF;
  -- This script deliberately requires a project dedicated to this application.
  FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation.tablename);
  END LOOP;
END $$;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
COMMIT;
