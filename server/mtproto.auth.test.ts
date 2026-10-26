import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "./security/secrets";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  records: new Map<number, { payload_encrypted: string; expiresAt: number }>(),
  query: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
  storedSession: vi.fn(),
  invoke: vi.fn(),
  connect: vi.fn(),
  acquired: true,
  throttleAllowed: true,
}));
vi.mock("./connection", () => ({
  getPool: () => ({
    query: mocks.query,
    connect: async () => ({
      query: mocks.txQuery,
      release: mocks.release,
      on: vi.fn(),
      removeListener: vi.fn(),
    }),
  }),
}));
vi.mock("./db", () => ({ getMtprotoSession: mocks.storedSession }));
vi.mock("telegram/extensions/Logger.js", () => ({
  Logger: class {
    constructor(public level: string) {}
  },
  LogLevel: { NONE: "none" },
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: class {
    constructor(public value: string) {}
    save() {
      return "synthetic-saved-session";
    }
  },
}));
vi.mock("telegram/Password.js", () => ({
  computeCheck: vi.fn(async () => ({ proof: "synthetic-proof" })),
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
      connect = vi.fn(() => mocks.connect());
      invoke = vi.fn((request: any) => mocks.invoke(request));
      getMe = vi.fn(async () => ({
        id: 77,
        firstName: "Owner",
        phone: "998900000000",
      }));
      destroy = vi.fn(async () => {});
      onError: any;
      constructor(
        public session: any,
        public apiId: number,
        public apiHash: string,
        public options: any
      ) {
        mocks.clients.push(this);
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

import {
  createClient,
  getApiCredentials,
  sendPhoneCode,
  signInWithCode,
  signInWithPassword,
  logoutSession,
} from "./mtproto";

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.records.clear();
  mocks.acquired = true;
  mocks.throttleAllowed = true;
  mocks.query.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
  mocks.txQuery
    .mockReset()
    .mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes("pg_try_advisory_lock"))
        return { rows: [{ acquired: mocks.acquired }], rowCount: 1 };
      if (sql.includes("INSERT INTO mtproto_auth_controls"))
        return { rowCount: mocks.throttleAllowed ? 1 : 0, rows: [] };
      if (sql.includes("DELETE FROM mtproto_pending_auth")) {
        if (sql.includes("user_id=$1")) mocks.records.delete(params[0]);
        else
          for (const [id, record] of mocks.records)
            if (record.expiresAt <= Date.now()) mocks.records.delete(id);
      }
      if (sql.includes("INSERT INTO mtproto_pending_auth"))
        mocks.records.set(params[0], {
          payload_encrypted: params[1],
          expiresAt: params[2],
        });
      if (sql.includes("UPDATE mtproto_pending_auth")) {
        const record = mocks.records.get(params[0]);
        if (!record || record.expiresAt <= Date.now())
          return { rowCount: 0, rows: [] };
        record.payload_encrypted = params[1];
      }
      if (sql.includes("SELECT") && sql.includes("FROM mtproto_pending_auth")) {
        const record = mocks.records.get(params[0]);
        return record && record.expiresAt > Date.now()
          ? { rowCount: 1, rows: [{ ...record, user_id: params[0] }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
  mocks.release.mockReset();
  mocks.storedSession.mockReset().mockResolvedValue(null);
  mocks.invoke
    .mockReset()
    .mockImplementation(async request =>
      request.kind === "SendCode"
        ? { phoneCodeHash: "synthetic-code-hash" }
        : {}
    );
  mocks.connect.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("TELEGRAM_API_ID", "123456");
  vi.stubEnv("TELEGRAM_API_HASH", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 21).toString("base64"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("request-scoped MTProto authentication", () => {
  it("requires operator credentials and disables hidden retries/logging", async () => {
    vi.stubEnv("TELEGRAM_API_ID", "");
    expect(() => getApiCredentials()).toThrow(/TELEGRAM_API_ID/);
    expect(mocks.clients).toHaveLength(0);
    vi.stubEnv("TELEGRAM_API_ID", "123456");
    const { client } = await createClient();
    expect((client as any).options).toMatchObject({
      requestRetries: 1,
      connectionRetries: 1,
      reconnectRetries: 0,
      autoReconnect: false,
      floodSleepThreshold: 0,
      baseLogger: { level: "none" },
    });
  });

  it("applies persisted throttling before contacting Telegram", async () => {
    mocks.throttleAllowed = false;
    await expect(sendPhoneCode(101, "+998900000000")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(mocks.clients).toHaveLength(0);
    expect(mocks.records.size).toBe(0);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });

  it("stores only ciphertext, closes each client, and continues after module reload", async () => {
    vi.useFakeTimers();
    await sendPhoneCode(102, "+998900000000");
    const ciphertext = mocks.records.get(102)!.payload_encrypted;
    expect(ciphertext).toMatch(/^enc:v1:/);
    expect(ciphertext).not.toMatch(/synthetic|998900000000/);
    expect(() => decryptSecret(ciphertext, "mtproto-auth:103")).toThrow();
    expect(mocks.clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.resetModules();
    const restored = await import("./mtproto");
    expect(await restored.signInWithCode(102, "12345")).toMatchObject({
      sessionString: "synthetic-saved-session",
      user: { id: "77" },
    });
    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1].session.value).toBe("synthetic-saved-session");
    expect(mocks.clients[1].connect).toHaveBeenCalledTimes(1);
    expect(mocks.clients[1].destroy).toHaveBeenCalledTimes(1);
    expect(mocks.records.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(restored.signInWithCode(102, "12345")).rejects.toThrow(
      /истекла/
    );
  });

  it("persists 2FA state across request modules without persisting a password", async () => {
    await sendPhoneCode(103, "+998900000000");
    mocks.invoke.mockRejectedValueOnce({
      errorMessage: "SESSION_PASSWORD_NEEDED",
    });
    await expect(signInWithCode(103, "12345")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "TWO_FACTOR_REQUIRED",
    });
    const pending = JSON.parse(
      decryptSecret(
        mocks.records.get(103)!.payload_encrypted,
        "mtproto-auth:103"
      )
    );
    expect(pending).toMatchObject({ needsPassword: true, attempts: 1 });
    expect(mocks.clients.every(c => c.destroy.mock.calls.length === 1)).toBe(
      true
    );
    vi.resetModules();
    const restored = await import("./mtproto");
    const commit = vi.fn(async () => {});
    expect(
      await restored.signInWithPassword(103, "owner-2fa-password", commit)
    ).toMatchObject({ user: { id: "77" } });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(mocks.clients).toHaveLength(3);
    expect(mocks.clients.every(c => c.destroy.mock.calls.length === 1)).toBe(
      true
    );
    expect(mocks.records.size).toBe(0);
    expect(JSON.stringify(mocks.txQuery.mock.calls)).not.toContain(
      "owner-2fa-password"
    );
  });

  it("claims invalid attempts durably and disconnects after every attempt", async () => {
    await sendPhoneCode(104, "+998900000000");
    mocks.invoke.mockRejectedValue({ errorMessage: "PHONE_CODE_INVALID" });
    for (let i = 0; i < 5; i++)
      await expect(signInWithCode(104, "12345")).rejects.toThrow(
        /Неверный код/
      );
    expect(mocks.clients).toHaveLength(6);
    expect(mocks.clients.every(c => c.destroy.mock.calls.length === 1)).toBe(
      true
    );
    await expect(signInWithCode(104, "12345")).rejects.toThrow(/истекла/);
    expect(mocks.clients).toHaveLength(6);
    expect(mocks.records.size).toBe(0);
  });

  it("rejects database-expired pending login without creating another client", async () => {
    await sendPhoneCode(105, "+998900000000");
    mocks.records.get(105)!.expiresAt = Date.now() - 1;
    await expect(signInWithCode(105, "12345")).rejects.toThrow(/истекла/);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.records.size).toBe(0);
  });

  it("cleans an unknown outcome and never returns the raw exception or retries", async () => {
    await sendPhoneCode(106, "+998900000000");
    mocks.invoke.mockRejectedValueOnce(new Error("raw-secret-code-12345"));
    await expect(signInWithCode(106, "12345")).rejects.toThrow(/Не удалось/);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.clients[1].destroy).toHaveBeenCalledTimes(1);
    expect(mocks.records.size).toBe(0);
  });

  it("persists mandatory flood waits without automatic retry", async () => {
    await sendPhoneCode(107, "+998900000000");
    mocks.invoke.mockRejectedValueOnce({
      errorMessage: "FLOOD_WAIT_120",
      seconds: 120,
    });
    await expect(signInWithCode(107, "12345")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const flood = mocks.txQuery.mock.calls.find(call =>
      call[0].startsWith("UPDATE mtproto_auth_controls")
    );
    expect(flood?.[1]).toEqual([107, 120]);
    expect(mocks.clients[1].destroy).toHaveBeenCalledTimes(1);
    expect(mocks.records.size).toBe(0);
  });

  it("refuses a concurrently held PostgreSQL auth lock before touching auth or Telegram", async () => {
    mocks.acquired = false;
    await expect(sendPhoneCode(108, "+998900000000")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mocks.txQuery).toHaveBeenCalledTimes(1);
    expect(mocks.clients).toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });

  it("times out an unknown send-code outcome, clears the timer, and frees its DB lock", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementationOnce(() => new Promise(() => {}));
    const attempt = sendPhoneCode(109, "+998900000000");
    const assertion = expect(attempt).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.clients[0].destroy).toHaveBeenCalled();
    expect(mocks.records.size).toBe(0);
    expect(mocks.txQuery.mock.calls.at(-1)?.[0]).toContain(
      "pg_advisory_unlock"
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends a code if an abandoned connection completes after its timeout", async () => {
    vi.useFakeTimers();
    let finishConnect!: () => void;
    mocks.connect.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishConnect = resolve;
        })
    );
    const assertion = expect(
      sendPhoneCode(111, "+998900000000")
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    finishConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.records.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits the final session before removing pending state or releasing the auth lock", async () => {
    await sendPhoneCode(112, "+998900000000");
    mocks.txQuery.mockClear();
    mocks.release.mockClear();
    let reachedCommit!: () => void;
    const reached = new Promise<void>(resolve => {
      reachedCommit = resolve;
    });
    let finishCommit!: () => void;
    const waiting = new Promise<void>(resolve => {
      finishCommit = resolve;
    });
    const commit = vi.fn(async (result: any) => {
      expect(result.user.id).toBe("77");
      expect(mocks.records.has(112)).toBe(true);
      reachedCommit();
      await waiting;
    });
    const auth = signInWithCode(112, "12345", commit);
    await reached;
    expect(
      mocks.txQuery.mock.calls.some(call =>
        call[0].includes("pg_advisory_unlock")
      )
    ).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
    finishCommit();
    await auth;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(mocks.records.has(112)).toBe(false);
    expect(mocks.txQuery.mock.calls.at(-1)?.[0]).toContain(
      "pg_advisory_unlock"
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a credential commit failure without retrying it or keeping pending auth", async () => {
    await sendPhoneCode(113, "+998900000000");
    const commit = vi.fn(async () => {
      throw new Error("synthetic-credential-commit-failure-secret");
    });
    await expect(signInWithCode(113, "12345", commit)).rejects.toThrow(
      /Не удалось/
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(mocks.records.has(113)).toBe(false);
    expect(mocks.clients[1].destroy).toHaveBeenCalledTimes(1);
    await expect(signInWithCode(113, "12345", commit)).rejects.toThrow(
      /истекла/
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("discards the shared auth connection if the logout sender unlock fails", async () => {
    const normalQuery = mocks.txQuery.getMockImplementation()!;
    mocks.txQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes("pg_advisory_unlock(") &&
        params?.[0] === "tg-sender:114:mtproto"
      )
        throw new Error("synthetic-unlock-failure");
      return normalQuery(sql, params);
    });
    await logoutSession(114);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it("pauses delivery before the sender barrier and removes local authorization", async () => {
    const normalQuery = mocks.txQuery.getMockImplementation()!;
    let releaseWorker!: () => void;
    const barrier = new Promise<void>(resolve => {
      releaseWorker = resolve;
    });
    let reachedBarrier!: () => void;
    const reached = new Promise<void>(resolve => {
      reachedBarrier = resolve;
    });
    mocks.txQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("pg_advisory_lock(")) {
        reachedBarrier();
        await barrier;
      }
      return normalQuery(sql, params);
    });
    const logout = logoutSession(110);
    await reached;
    const calls = mocks.txQuery.mock.calls.map(call => call[0] as string);
    expect(calls.findIndex(sql => sql.includes("AUTH_REQUIRED"))).toBeLessThan(
      calls.findIndex(sql => sql.includes("pg_advisory_lock("))
    );
    expect(
      calls.some(sql => sql.includes("DELETE FROM mtproto_sessions"))
    ).toBe(false);
    releaseWorker();
    await logout;
    expect(
      mocks.txQuery.mock.calls.some(call =>
        call[0].includes("DELETE FROM mtproto_sessions")
      )
    ).toBe(true);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
