CREATE TABLE maintenance_jobs (
  name text PRIMARY KEY,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_file text,
  last_bytes bigint,
  last_error text,
  failure_count integer NOT NULL DEFAULT 0,
  last_rehearsal_at timestamptz,
  last_rehearsal_error text
);
INSERT INTO maintenance_jobs(name) VALUES ('daily_backup');
