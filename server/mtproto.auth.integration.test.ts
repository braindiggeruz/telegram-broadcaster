import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { databasePoolConfig } from "./connection";
import { decryptSecret } from "./security/secrets";

// Telegram's transport and the unused stored-account lookup are mocked. State,
// expiry, throttling and locks use actual independent PostgreSQL sessions.
const transport = vi.hoisted(() => ({ clients: [] as any[], invoke: vi.fn() }));
vi.mock("./db", () => ({ getMtprotoSession: async () => null }));
vi.mock("telegram/extensions/Logger.js", () => ({
  Logger: class {},
  LogLevel: { NONE: "none" },
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: class {
    constructor(public value: string) {}
    save() {
      return "synthetic-persisted-session";
    }
  },
}));
vi.mock("telegram/Password.js", () => ({
  computeCheck: async () => ({ proof: "synthetic-proof" }),
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
      connect = vi.fn(async () => {});
      invoke = vi.fn((request: any) => transport.invoke(request));
      destroy = vi.fn(async () => {});
      getMe = vi.fn(async () => ({ id: 99001, firstName: "Synthetic" }));
      constructor(public session: any) {
        transport.clients.push(this);
      }
    },
    Api: {
      CodeSettings: request("CodeSettings"),
      auth: {
        SendCode: request("SendCode"),
        SignIn: request("SignIn"),
        CheckPassword: request("CheckPassword"),
        LogOut: request("LogOut"),
      },
      account: { GetPassword: request("GetPassword") },
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("durable encrypted Telegram auth on PostgreSQL", () => {
  const schema = `mtproto_auth_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  const cleanups: Array<() => Promise<void>> = [];

  async function newRequestModule() {
    vi.resetModules();
    const connection = await import("./connection");
    cleanups.push(connection.closePool);
    const auth = await import("./mtproto");
    return {
      sendPhoneCode: (...args: Parameters<typeof auth.sendPhoneCode>) =>
        connection.runWithDatabaseScope(() => auth.sendPhoneCode(...args)),
      signInWithCode: (...args: Parameters<typeof auth.signInWithCode>) =>
        connection.runWithDatabaseScope(() => auth.signInWithCode(...args)),
      signInWithPassword: (
        ...args: Parameters<typeof auth.signInWithPassword>
      ) =>
        connection.runWithDatabaseScope(() => auth.signInWithPassword(...args)),
    };
  }

  // Re-importing the real DB/GramJS dependency graph is deliberately part of
  // this suite; allow for Windows transform overhead under parallel CI load.
  const integrationTest = (name: string, run: () => Promise<void>) =>
    it(name, run, 30_000);

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
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 31).toString("base64"));
    vi.stubEnv("TELEGRAM_API_ID", "123456");
    vi.stubEnv("TELEGRAM_API_HASH", "0123456789abcdef0123456789abcdef");
    pool = new Pool(databasePoolConfig());
    for (const filename of ["005-mtproto-auth.sql", "013_cloud_auth_state.sql"])
      await pool.query(await readFile(`migrations/${filename}`, "utf8"));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE mtproto_pending_auth,mtproto_auth_controls");
    transport.clients.length = 0;
    transport.invoke
      .mockReset()
      .mockImplementation(async request =>
        request.kind === "SendCode" ? { phoneCodeHash: "synthetic-hash" } : {}
      );
  });
  afterAll(async () => {
    await Promise.all(cleanups.map(close => close()));
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  integrationTest(
    "resumes after replacing the request module and pool with no plaintext auth in the row",
    async () => {
      await (await newRequestModule()).sendPhoneCode(55101, "+998900000000");
      const record = (
        await pool.query(
          "SELECT * FROM mtproto_pending_auth WHERE user_id=55101"
        )
      ).rows[0];
      expect(record.payload_encrypted).toMatch(/^enc:v1:/);
      expect(JSON.stringify(record)).not.toMatch(/synthetic|998900000000/);
      expect(record.expires_at.getTime()).toBeGreaterThan(Date.now() + 290_000);
      expect(record.expires_at.getTime()).toBeLessThan(Date.now() + 301_000);
      expect(transport.clients[0].destroy).toHaveBeenCalledTimes(1);
      const next = await newRequestModule();
      expect(await next.signInWithCode(55101, "12345")).toMatchObject({
        sessionString: "synthetic-persisted-session",
        user: { id: "99001" },
      });
      expect(transport.clients[1].session.value).toBe(
        "synthetic-persisted-session"
      );
      expect(transport.clients[1].destroy).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
    }
  );

  integrationTest(
    "persists the 2FA stage and resumes it from another isolate",
    async () => {
      await (await newRequestModule()).sendPhoneCode(55102, "+998900000000");
      transport.invoke.mockRejectedValueOnce({
        errorMessage: "SESSION_PASSWORD_NEEDED",
      });
      await expect(
        (await newRequestModule()).signInWithCode(55102, "12345")
      ).rejects.toThrow("TWO_FACTOR_REQUIRED");
      const record = (
        await pool.query(
          "SELECT payload_encrypted FROM mtproto_pending_auth WHERE user_id=55102"
        )
      ).rows[0];
      const decoded = JSON.parse(
        decryptSecret(record.payload_encrypted, "mtproto-auth:55102")
      );
      expect(decoded).toMatchObject({ needsPassword: true, attempts: 1 });
      expect(
        await (
          await newRequestModule()
        ).signInWithPassword(55102, "synthetic-password")
      ).toMatchObject({ user: { id: "99001" } });
      expect(
        transport.clients.every(
          client => client.destroy.mock.calls.length === 1
        )
      ).toBe(true);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
    }
  );

  integrationTest(
    "rejects database expiry and ciphertext copied to another owner before any auth call",
    async () => {
      await (await newRequestModule()).sendPhoneCode(55103, "+998900000000");
      await pool.query(
        "INSERT INTO mtproto_pending_auth(user_id,payload_encrypted,expires_at) SELECT 55104,payload_encrypted,expires_at FROM mtproto_pending_auth WHERE user_id=55103"
      );
      await expect(
        (await newRequestModule()).signInWithCode(55104, "12345")
      ).rejects.toThrow(/истекла/);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM mtproto_pending_auth WHERE user_id=55103"
          )
        ).rowCount
      ).toBe(1);
      await pool.query(
        "UPDATE mtproto_pending_auth SET expires_at=now()-interval '1 second' WHERE user_id=55103"
      );
      await expect(
        (await newRequestModule()).signInWithCode(55103, "12345")
      ).rejects.toThrow(/истекла/);
      expect(transport.clients).toHaveLength(1);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
    }
  );

  integrationTest(
    "refuses a concurrent request on another pool and keeps code throttling after release",
    async () => {
      let sendStarted!: () => void;
      const started = new Promise<void>(resolve => {
        sendStarted = resolve;
      });
      let releaseSend!: () => void;
      const waiting = new Promise<void>(resolve => {
        releaseSend = resolve;
      });
      transport.invoke.mockImplementationOnce(async () => {
        sendStarted();
        await waiting;
        return { phoneCodeHash: "synthetic-hash" };
      });
      const first = (await newRequestModule()).sendPhoneCode(
        55105,
        "+998900000000"
      );
      try {
        await started;
        await expect(
          (await newRequestModule()).sendPhoneCode(55105, "+998900000000")
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(transport.clients).toHaveLength(1);
      } finally {
        releaseSend();
        await first;
      }
      await expect(
        (await newRequestModule()).sendPhoneCode(55105, "+998900000000")
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(transport.clients).toHaveLength(1);
    }
  );

  integrationTest(
    "holds the auth lock through credential commit and cleans a failed commit",
    async () => {
      await (await newRequestModule()).sendPhoneCode(55108, "+998900000000");
      let reachedCommit!: () => void;
      const reached = new Promise<void>(resolve => {
        reachedCommit = resolve;
      });
      let finishCommit!: () => void;
      const waiting = new Promise<void>(resolve => {
        finishCommit = resolve;
      });
      const commit = vi.fn(async () => {
        reachedCommit();
        await waiting;
      });
      const signingIn = (await newRequestModule()).signInWithCode(
        55108,
        "12345",
        commit
      );
      try {
        await reached;
        await expect(
          (await newRequestModule()).signInWithCode(55108, "12345")
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          (
            await pool.query(
              "SELECT 1 FROM mtproto_pending_auth WHERE user_id=55108"
            )
          ).rowCount
        ).toBe(1);
      } finally {
        finishCommit();
        await signingIn;
      }
      expect(commit).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
      await (await newRequestModule()).sendPhoneCode(55109, "+998900000000");
      const failingCommit = vi.fn(async () => {
        throw new Error("synthetic-commit-failure");
      });
      await expect(
        (await newRequestModule()).signInWithCode(55109, "12345", failingCommit)
      ).rejects.toThrow(/Не удалось/);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
      await expect(
        (await newRequestModule()).signInWithCode(55109, "12345", failingCommit)
      ).rejects.toThrow(/истекла/);
      expect(failingCommit).toHaveBeenCalledTimes(1);
    }
  );

  integrationTest(
    "retains the attempt budget across modules and removes unknown outcomes",
    async () => {
      await (await newRequestModule()).sendPhoneCode(55106, "+998900000000");
      transport.invoke.mockRejectedValue({
        errorMessage: "PHONE_CODE_INVALID",
      });
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(
          (await newRequestModule()).signInWithCode(55106, "12345")
        ).rejects.toThrow(/Неверный код/);
      await expect(
        (await newRequestModule()).signInWithCode(55106, "12345")
      ).rejects.toThrow(/истекла/);
      expect(transport.clients).toHaveLength(6);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
      transport.invoke.mockResolvedValueOnce({
        phoneCodeHash: "synthetic-hash",
      });
      await (await newRequestModule()).sendPhoneCode(55107, "+998900000000");
      transport.invoke.mockRejectedValueOnce(
        new Error("synthetic-secret-unknown-network-outcome")
      );
      await expect(
        (await newRequestModule()).signInWithCode(55107, "12345")
      ).rejects.toThrow(/Не удалось/);
      expect(
        (await pool.query("SELECT 1 FROM mtproto_pending_auth")).rowCount
      ).toBe(0);
      expect(
        transport.clients.every(
          client => client.destroy.mock.calls.length === 1
        )
      ).toBe(true);
    }
  );
});
