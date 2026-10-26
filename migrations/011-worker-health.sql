-- A liveness heartbeat is not proof that the worker can successfully process its loop.
ALTER TABLE delivery_worker_heartbeats ADD COLUMN last_success_at timestamptz;
