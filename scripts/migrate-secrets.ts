import "dotenv/config";
import { getPool, closePool } from "../server/connection";
import { migrateLegacySecrets } from "../server/db";
try {
  if (process.env.LIVE_SEND_ENABLED !== "false")
    throw new Error("LIVE_SEND_MUST_BE_DISABLED");
  const workers = await getPool().query(
    "SELECT count(*)::int AS count FROM delivery_worker_heartbeats WHERE last_seen_at>now()-interval '30 seconds'"
  );
  if (workers.rows[0].count)
    throw new Error("STOP_WORKER_BEFORE_SECRET_MIGRATION");
  const result = await migrateLegacySecrets();
  console.log(JSON.stringify({ migrated: true, ...result }));
} catch (error) {
  const known =
    error instanceof Error &&
    [
      "LIVE_SEND_MUST_BE_DISABLED",
      "STOP_WORKER_BEFORE_SECRET_MIGRATION",
    ].includes(error.message)
      ? error.message
      : "SECRET_MIGRATION_FAILED";
  console.error(known);
  process.exitCode = 1;
} finally {
  await closePool();
}
