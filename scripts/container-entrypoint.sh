#!/bin/sh
set -eu
umask 077

export NODE_ENV=production
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3037}"
export LIVE_SEND_ENABLED="${LIVE_SEND_ENABLED:-false}"

# The environment is populated by the host's secret manager at runtime only.
# Never print environment values, driver exceptions or a database connection URL.
node --input-type=module -e '
const required = ["DATABASE_URL", "APP_ORIGIN", "OWNER_OPEN_ID", "OWNER_PASSWORD_HASH", "SESSION_SECRET", "ENCRYPTION_KEY", "BACKUP_KEY_BASE64", "TELEGRAM_WEBHOOK_SECRET"];
if (required.some(key => !process.env[key])) {
  console.error("CONTAINER_CONFIGURATION_MISSING: configure the required runtime secrets.");
  process.exit(1);
}
try {
  const origin = new URL(process.env.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
} catch {
  console.error("CONTAINER_ORIGIN_INVALID: APP_ORIGIN must be the public HTTPS origin.");
  process.exit(1);
}
'

# Migrations are serialized by PostgreSQL advisory lock. A migration failure
# stops startup; raw errors are withheld because drivers can expose input data.
node --input-type=module -e '
try {
  await import("./dist/migrate.js");
} catch {
  console.error("MIGRATION_FAILED: check database access and migration compatibility.");
  process.exit(1);
}
'

# The existing supervisor forwards SIGTERM to both processes; tini reaps children.
exec node scripts/run.mjs production
