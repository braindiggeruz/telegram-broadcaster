import { getPool } from "./connection";

// Keep the read-only status path independent of Node-only backup subprocesses.
export async function getMaintenanceStatus() {
  return (
    await getPool()
      .query(`SELECT name,status,next_run_at,last_started_at,last_finished_at,last_success_at,last_file,last_bytes,last_error,
    failure_count,last_rehearsal_at,last_rehearsal_error FROM maintenance_jobs ORDER BY name`)
  ).rows;
}
