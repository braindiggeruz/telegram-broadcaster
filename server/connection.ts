import { Pool, type PoolConfig } from "pg";

let pool: Pool | undefined;

export function databasePoolConfig(
  env: NodeJS.ProcessEnv = process.env
): PoolConfig {
  const connectionString = env.DATABASE_URL || env.SUPABASE_DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname
  );
  if (env.DATABASE_SSL === "disable" && !local)
    throw new Error(
      "Disabling database TLS is allowed only for loopback connections"
    );
  // pg parses these URL arguments after PoolConfig and can otherwise override TLS verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl:
      env.DATABASE_SSL === "disable"
        ? false
        : {
            rejectUnauthorized: true,
            ...(env.DATABASE_CA
              ? { ca: env.DATABASE_CA.replace(/\\n/g, "\n") }
              : {}),
          },
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: "tg-sender-v2",
  };
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(databasePoolConfig());
    // Never print a driver error which could contain connection information.
    pool.on("error", () =>
      console.error("[Database] Idle connection unavailable")
    );
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}
