import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolConfig } from "pg";
import {
  createSupabaseRelayStream,
  supabaseRelayConfiguration,
} from "./supabaseRelay";

let pool: Pool | undefined;
const databaseScope = new AsyncLocalStorage<Pool>();

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
  // pg gives these query parameters precedence over the authority we validated.
  const identityOverrides = new Set([
    "host",
    "hostaddr",
    "port",
    "user",
    "username",
    "password",
    "dbname",
    "database",
    "db",
  ]);
  const tlsOverrides = new Set([
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "ssl",
    "sslnegotiation",
    "uselibpqcompat",
  ]);
  for (const key of [...url.searchParams.keys()]) {
    if (identityOverrides.has(key.toLowerCase()))
      throw new Error("DATABASE_URL connection overrides are not allowed");
    if (tlsOverrides.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const relay =
    env.DATABASE_TRANSPORT === "supabase-relay"
      ? supabaseRelayConfiguration(env, url)
      : undefined;
  return {
    connectionString: url.toString(),
    ssl:
      relay || env.DATABASE_SSL === "disable"
        ? false
        : {
            rejectUnauthorized: true,
            ...(env.DATABASE_CA
              ? { ca: env.DATABASE_CA.replace(/\\n/g, "\n") }
              : {}),
          },
    max: 10,
    ...(relay
      ? {
          // Outer WSS is verified HTTPS. The private relay establishes and
          // verifies upstream TLS before accepting PostgreSQL protocol bytes.
          stream: createSupabaseRelayStream(relay),
          enableChannelBinding: false,
        }
      : {}),
    connectionTimeoutMillis: relay ? 15000 : 5000,
    idleTimeoutMillis: 30000,
    application_name: "tg-sender-v2",
  };
}

function createPool(max: number): Pool {
  const created = new Pool({ ...databasePoolConfig(), max });
  // Never print a driver error which could contain connection information.
  created.on("error", () =>
    console.error("[Database] Idle connection unavailable")
  );
  return created;
}

export function getPool(): Pool {
  const scoped = databaseScope.getStore();
  if (scoped) return scoped;
  if (!pool) pool = createPool(10);
  return pool;
}

// Cloudflare sockets belong to the request that created them. Each request or
// scheduled invocation owns a pool; nested operations share it until completion.
export async function runWithDatabaseScope<T>(
  callback: () => Promise<T>
): Promise<T> {
  if (databaseScope.getStore()) return callback();
  const scoped = createPool(3);
  return databaseScope.run(scoped, async () => {
    try {
      return await callback();
    } finally {
      await scoped.end();
    }
  });
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}
