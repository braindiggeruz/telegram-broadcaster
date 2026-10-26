import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPool } from "../server/connection";
const pool = getPool();
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(726301)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS app_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  const files = [
    resolve("drizzle/0000_massive_chamber.sql"),
    ...readdirSync("migrations")
      .filter(f => f.endsWith(".sql"))
      .sort()
      .map(f => resolve("migrations", f)),
  ];
  for (const path of files) {
    const name = path.split(/[\\/]/).at(-1)!;
    const sql = readFileSync(path, "utf8");
    // Git on Windows may change LF to CRLF. SQL content stays identical.
    const normalizedSql = sql.replace(/\r\n/g, "\n");
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const checksum = hash(normalizedSql);
    const compatibleChecksums = new Set([
      checksum,
      hash(sql),
      hash(normalizedSql.replace(/\n/g, "\r\n")),
    ]);
    const applied = await client.query(
      "SELECT checksum FROM app_migrations WHERE name=$1",
      [name]
    );
    if (applied.rowCount) {
      if (!compatibleChecksums.has(applied.rows[0].checksum))
        throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      if (name.startsWith("0000_")) {
        const existing = await client.query(
          "SELECT to_regclass('public.users') AS users"
        );
        if (existing.rows[0].users) {
          if (process.env.ADOPT_LEGACY_SCHEMA !== "true")
            throw new Error(
              "Legacy database detected. Back up, review schema and explicitly set ADOPT_LEGACY_SCHEMA=true."
            );
        } else await client.query(sql);
      } else await client.query(sql);
      await client.query(
        "INSERT INTO app_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum]
      );
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(726301)");
  client.release();
  await pool.end();
}
