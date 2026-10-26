import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closePool,
  databasePoolConfig,
  runWithDatabaseScope,
} from "./connection";
import { upsertMtprotoSession } from "./db";
import { logoutSession, sendPhoneCode, signInWithCode } from "./mtproto";

// Real PostgreSQL credentials/transactions, synthetic Telegram transport only.
vi.mock("telegram/extensions/Logger.js", () => ({
  Logger: class {},
  LogLevel: { NONE: "none" },
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: class {
    constructor(public value: string) {}
    save() {
      return "synthetic-commit-session";
    }
  },
}));
vi.mock("telegram", () => {
  const request = (kind: string) =>
    class {
      kind = kind;
      constructor(input?: any) {
        Object.assign(this, input);
      }
    };
  return {
    TelegramClient: class {
      async connect() {}
      async invoke(request: any) {
        return request.kind === "SendCode"
          ? { phoneCodeHash: "synthetic-commit-hash" }
          : {};
      }
      async destroy() {}
      async getMe() {
        return { id: 99002, firstName: "Synthetic" };
      }
    },
    Api: {
      CodeSettings: request("CodeSettings"),
      auth: {
        SendCode: request("SendCode"),
        SignIn: request("SignIn"),
        LogOut: request("LogOut"),
      },
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "MTProto credential commit uses the auth lock connection",
  () => {
    const schema = `mtproto_commit_test_${randomUUID().replaceAll("-", "")}`;
    let admin: Pool, pool: Pool;

    beforeAll(async () => {
      admin = new Pool(
        databasePoolConfig({
          ...process.env,
          DATABASE_URL: url,
          DATABASE_SSL: "disable",
        })
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const isolated = new URL(url!);
      isolated.searchParams.set("options", `-c search_path=${schema}`);
      vi.stubEnv("DATABASE_URL", isolated.toString());
      vi.stubEnv("DATABASE_SSL", "disable");
      vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 32).toString("base64"));
      vi.stubEnv("TELEGRAM_API_ID", "123456");
      vi.stubEnv("TELEGRAM_API_HASH", "0123456789abcdef0123456789abcdef");
      pool = new Pool(databasePoolConfig());
      await pool.query(
        (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
          '"public".',
          `"${schema}".`
        )
      );
      for (const filename of (await readdir("migrations"))
        .filter(name => name.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(`migrations/${filename}`, "utf8"));
    }, 30_000);
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE mtproto_pending_auth,mtproto_auth_controls,mtproto_sessions,sender_controls,audit_events CASCADE"
      );
    });
    afterAll(async () => {
      await closePool();
      if (pool) await pool.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
      vi.unstubAllEnvs();
    });

    function commit(
      userId: number,
      result: Awaited<ReturnType<typeof signInWithCode>>,
      client: PoolClient
    ) {
      return upsertMtprotoSession(
        userId,
        {
          phone: result.user.phone,
          telegramId: result.user.id,
          sessionString: result.sessionString,
          isActive: true,
        },
        client
      );
    }

    it("commits on the caller's live connection without releasing its auth lock", async () => {
      const owner = 55201;
      await runWithDatabaseScope(() => sendPhoneCode(owner, "+998900000000"));
      const complete = vi.fn(async (result, authClient: PoolClient) => {
        const before = (
          await authClient.query("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid;
        await commit(owner, result, authClient);
        const after = (await authClient.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        expect(after).toBe(before);
        const contender = await pool.connect();
        try {
          const lock = await contender.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
            [`tg-sender:mtproto-auth:${owner}`]
          );
          expect(lock.rows[0].acquired).toBe(false);
        } finally {
          await contender.query("SELECT pg_advisory_unlock_all()");
          contender.release();
        }
      });
      await runWithDatabaseScope(() =>
        signInWithCode(owner, "12345", complete)
      );
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        (
          await pool.query(
            'SELECT "sessionString" FROM mtproto_sessions WHERE "userId"=$1',
            [owner]
          )
        ).rows[0].sessionString
      ).toMatch(/^enc:v1:/);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM mtproto_pending_auth WHERE user_id=$1",
            [owner]
          )
        ).rowCount
      ).toBe(0);
    });

    it("cannot reauthorize after its auth connection is lost and another request logs out", async () => {
      const owner = 55202;
      await runWithDatabaseScope(() => sendPhoneCode(owner, "+998900000000"));
      let reachedCommit!: (pid: number) => void;
      const reached = new Promise<number>(resolve => {
        reachedCommit = resolve;
      });
      let finishCommit!: () => void;
      const waiting = new Promise<void>(resolve => {
        finishCommit = resolve;
      });
      const complete = vi.fn(async (result, authClient: PoolClient) => {
        const backend = (
          await authClient.query(
            "SELECT pg_backend_pid() AS pid,current_schema() AS schema"
          )
        ).rows[0];
        expect(backend.schema).toBe(schema);
        reachedCommit(backend.pid);
        await waiting;
        await commit(owner, result, authClient);
      });
      // Attach a rejection handler immediately; the intentionally severed session
      // may fail before this test finishes driving the independent logout.
      const signingIn = runWithDatabaseScope(() =>
        signInWithCode(owner, "12345", complete)
      );
      const outcome = signingIn.then(
        () => "unexpected-success",
        () => "rejected"
      );
      try {
        const pid = await reached;
        // Terminate only this test's captured backend in its random isolated schema.
        const stopped = await admin.query(
          "SELECT pg_terminate_backend($1) AS stopped",
          [pid]
        );
        expect(stopped.rows[0].stopped).toBe(true);
        await runWithDatabaseScope(() => logoutSession(owner));
      } finally {
        finishCommit();
      }
      expect(await outcome).toBe("rejected");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        (
          await pool.query('SELECT 1 FROM mtproto_sessions WHERE "userId"=$1', [
            owner,
          ])
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT state FROM sender_controls WHERE sender_key=$1",
            [`${owner}:mtproto`]
          )
        ).rows[0].state
      ).toBe("AUTH_REQUIRED");
      expect(
        (
          await pool.query(
            "SELECT 1 FROM mtproto_pending_auth WHERE user_id=$1",
            [owner]
          )
        ).rowCount
      ).toBe(0);
    }, 30_000);
  }
);
