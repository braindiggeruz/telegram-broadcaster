import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

const poolMock = vi.hoisted(() => {
  class TestPool {
    static instances: TestPool[] = [];
    ended = false;
    on = vi.fn(() => this);
    query = vi.fn(async () => {
      if (this.ended) throw new Error("Query used a disposed request pool");
      return { rows: [], rowCount: 0 };
    });
    end = vi.fn(async () => {
      this.ended = true;
    });
    constructor(readonly options: Record<string, unknown>) {
      TestPool.instances.push(this);
    }
  }
  return { TestPool };
});

vi.mock("pg", async importOriginal => {
  const original = await importOriginal<typeof import("pg")>();
  return {
    ...original,
    Pool: poolMock.TestPool,
    default: { ...original.default, Pool: poolMock.TestPool },
  };
});

import {
  closePool,
  databasePoolConfig,
  getPool,
  runWithDatabaseScope,
} from "./connection";
import { getDb } from "./db";

function currentPool() {
  return getPool() as unknown as InstanceType<typeof poolMock.TestPool>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await closePool();
  poolMock.TestPool.instances = [];
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1/test_scope");
  vi.stubEnv("DATABASE_SSL", "disable");
});

afterEach(async () => {
  await closePool();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("database invocation scope", () => {
  it("rejects query overrides that could redirect a validated database connection", () => {
    for (const key of [
      "host",
      "hostaddr",
      "port",
      "user",
      "username",
      "password",
      "dbname",
      "database",
      "db",
      "HOST",
    ]) {
      expect(() =>
        databasePoolConfig({
          DATABASE_URL: `postgresql://test:test@127.0.0.1/test_scope?${key}=override`,
          DATABASE_SSL: "disable",
        })
      ).toThrow("DATABASE_URL connection overrides are not allowed");
    }
  });

  it("removes all URL SSL controls while retaining explicitly configured verified TLS", () => {
    const configured = databasePoolConfig({
      DATABASE_URL:
        "postgresql://test:test@db.example/test_scope?ssl=0&sslmode=disable&sslcert=ignored&sslkey=ignored&sslrootcert=ignored&sslnegotiation=direct&uselibpqcompat=true&options=-c%20search_path%3Dtest",
      DATABASE_CA: "test\\ncertificate",
    });
    expect(configured.ssl).toEqual({
      rejectUnauthorized: true,
      ca: "test\ncertificate",
    });
    const url = new URL(configured.connectionString!);
    expect([...url.searchParams.keys()]).toEqual(["options"]);
  });

  it("preserves the shared Node pool outside a scope and replaces it after close", async () => {
    const first = currentPool();
    expect(currentPool()).toBe(first);
    expect(first.options.max).toBe(10);
    await closePool();
    await closePool();
    expect(first.end).toHaveBeenCalledTimes(1);
    const replacement = currentPool();
    expect(replacement).not.toBe(first);
    expect(replacement.ended).toBe(false);
  });

  it("keeps nested operations in one scope until the outer operation settles", async () => {
    const result = await runWithDatabaseScope(async () => {
      const outer = currentPool();
      expect(outer.options.max).toBe(3);
      const nested = await runWithDatabaseScope(async () => {
        await Promise.resolve();
        expect(currentPool()).toBe(outer);
        return runWithDatabaseScope(async () => currentPool());
      });
      expect(nested).toBe(outer);
      expect(outer.end).not.toHaveBeenCalled();
      return { value: "complete", pool: outer };
    });
    expect(result.value).toBe("complete");
    expect(result.pool.end).toHaveBeenCalledTimes(1);
    expect(poolMock.TestPool.instances).toHaveLength(1);
  });

  it("isolates overlapping invocations across awaits and restores the Node context", async () => {
    const globalPool = currentPool();
    const firstReady = deferred();
    const secondReady = deferred();
    const releaseSecond = deferred();
    const first = runWithDatabaseScope(async () => {
      const scoped = currentPool();
      firstReady.resolve();
      await secondReady.promise;
      expect(currentPool()).toBe(scoped);
      return scoped;
    });
    const second = runWithDatabaseScope(async () => {
      const scoped = currentPool();
      await firstReady.promise;
      secondReady.resolve();
      await releaseSecond.promise;
      expect(currentPool()).toBe(scoped);
      expect(scoped.ended).toBe(false);
      return scoped;
    });
    const firstPool = await first;
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(currentPool()).toBe(globalPool);
    releaseSecond.resolve();
    const secondPool = await second;
    expect(secondPool).not.toBe(firstPool);
    expect(secondPool).not.toBe(globalPool);
    expect(secondPool.end).toHaveBeenCalledTimes(1);
    expect(globalPool.end).not.toHaveBeenCalled();
  });

  it("disposes the outer scope exactly once when a nested operation rejects", async () => {
    const failure = new Error("test operation failure");
    await expect(
      runWithDatabaseScope(async () => {
        await runWithDatabaseScope(async () => {
          await Promise.resolve();
          throw failure;
        });
      })
    ).rejects.toBe(failure);
    expect(poolMock.TestPool.instances).toHaveLength(1);
    expect(poolMock.TestPool.instances[0].end).toHaveBeenCalledTimes(1);
    const next = await runWithDatabaseScope(async () => currentPool());
    expect(next).not.toBe(poolMock.TestPool.instances[0]);
    expect(next.end).toHaveBeenCalledTimes(1);
  });

  it("disposes a pool even if the callback throws before returning a promise", async () => {
    const failure = new Error("synchronous failure");
    await expect(
      runWithDatabaseScope(() => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(poolMock.TestPool.instances[0].end).toHaveBeenCalledTimes(1);
  });

  it("waits for disposal before resolving the invocation result", async () => {
    const cleanupStarted = deferred();
    const allowCleanup = deferred();
    let resolved = false;
    const result = runWithDatabaseScope(async () => {
      currentPool().end.mockImplementationOnce(async () => {
        cleanupStarted.resolve();
        await allowCleanup.promise;
      });
      return "finished";
    }).then(value => {
      resolved = true;
      return value;
    });
    await cleanupStarted.promise;
    expect(resolved).toBe(false);
    allowCleanup.resolve();
    await expect(result).resolves.toBe("finished");
  });

  it("binds cached Drizzle instances and executed queries to the active pool", async () => {
    const globalDb = await getDb();
    const globalPool = currentPool();
    const firstDb = await runWithDatabaseScope(async () => {
      const db = await getDb();
      expect(await getDb()).toBe(db);
      expect(db).not.toBe(globalDb);
      await db.execute(sql`select 1`);
      expect(currentPool().query).toHaveBeenCalledTimes(1);
      return db;
    });
    await runWithDatabaseScope(async () => {
      const db = await getDb();
      expect(db).not.toBe(firstDb);
      expect(db).not.toBe(globalDb);
      // A singleton Drizzle regression would query the already disposed pool.
      await db.execute(sql`select 2`);
      expect(currentPool().query).toHaveBeenCalledTimes(1);
    });
    expect(await getDb()).toBe(globalDb);
    expect(globalPool.query).not.toHaveBeenCalled();
    await globalDb.execute(sql`select 3`);
    expect(globalPool.query).toHaveBeenCalledTimes(1);
  });

  it("preserves verified remote TLS and strips connection URL TLS overrides", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://test:test@db.example/test_scope?sslmode=disable"
    );
    vi.stubEnv("DATABASE_SSL", "require");
    vi.stubEnv("DATABASE_CA", "test\\ncertificate");
    await runWithDatabaseScope(async () => {
      expect(currentPool().options.ssl).toEqual({
        rejectUnauthorized: true,
        ca: "test\ncertificate",
      });
      expect(currentPool().options.connectionString).not.toContain("sslmode");
    });
    vi.stubEnv("DATABASE_SSL", "disable");
    await expect(runWithDatabaseScope(async () => undefined)).rejects.toThrow(
      "Disabling database TLS is allowed only for loopback connections"
    );
    expect(poolMock.TestPool.instances).toHaveLength(1);
  });
});
