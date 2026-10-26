import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  query: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
  storedSession: vi.fn(),
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
      connect = vi.fn(async () => {});
      invoke = vi.fn(async (request: any) =>
        request.kind === "SendCode"
          ? { phoneCodeHash: "synthetic-code-hash" }
          : {}
      );
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
  mocks.query
    .mockReset()
    .mockResolvedValue({ rowCount: 1, rows: [{ user_id: 1 }] });
  mocks.txQuery.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
  mocks.release.mockReset();
  mocks.storedSession.mockReset().mockResolvedValue(null);
  vi.stubEnv("TELEGRAM_API_ID", "123456");
  vi.stubEnv("TELEGRAM_API_HASH", "0123456789abcdef0123456789abcdef");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("MTProto authentication lifecycle", () => {
  it("requires the operator's API credentials and disables hidden retries/logging", async () => {
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

  it("applies persisted code request throttling before contacting Telegram", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(sendPhoneCode(101, "+998900000000")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(mocks.clients).toHaveLength(0);
    expect(mocks.query.mock.calls[0][0]).toContain("mtproto_auth_controls");
  });

  it("destroys a completed auth client and never keeps an idle authenticated cache", async () => {
    await sendPhoneCode(102, "+998900000000");
    const client = mocks.clients[0];
    expect(await signInWithCode(102, "12345")).toMatchObject({
      sessionString: "synthetic-saved-session",
      user: { id: "77" },
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await expect(signInWithCode(102, "12345")).rejects.toThrow(/истекла/);
  });

  it("preserves only the pending state needed for 2FA, then destroys it", async () => {
    await sendPhoneCode(103, "+998900000000");
    const client = mocks.clients[0];
    client.invoke.mockRejectedValueOnce({
      errorMessage: "SESSION_PASSWORD_NEEDED",
    });
    await expect(signInWithCode(103, "12345")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "TWO_FACTOR_REQUIRED",
    });
    expect(client.destroy).not.toHaveBeenCalled();
    expect(await signInWithPassword(103, "owner-2fa-password")).toMatchObject({
      user: { id: "77" },
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("limits invalid credentials to five attempts and disconnects immediately", async () => {
    await sendPhoneCode(104, "+998900000000");
    const client = mocks.clients[0];
    client.invoke.mockRejectedValue({ errorMessage: "PHONE_CODE_INVALID" });
    for (let i = 0; i < 5; i++)
      await expect(signInWithCode(104, "12345")).rejects.toThrow(
        /Неверный код/
      );
    expect(client.destroy).toHaveBeenCalledTimes(1);
    const calls = client.invoke.mock.calls.length;
    await expect(signInWithCode(104, "12345")).rejects.toThrow(/истекла/);
    expect(client.invoke).toHaveBeenCalledTimes(calls);
  });

  it("expires pending login after five minutes without waiting for another request", async () => {
    vi.useFakeTimers();
    await sendPhoneCode(105, "+998900000000");
    const client = mocks.clients[0];
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await expect(signInWithCode(105, "12345")).rejects.toThrow(/истекла/);
  });

  it("destroys replaced pending clients and hides unknown raw exceptions", async () => {
    await sendPhoneCode(106, "+998900000000");
    const first = mocks.clients[0];
    await sendPhoneCode(106, "+998900000001");
    expect(first.destroy).toHaveBeenCalledTimes(1);
    const second = mocks.clients[1];
    second.invoke.mockRejectedValue(new Error("raw-secret-code-12345"));
    await expect(signInWithCode(106, "12345")).rejects.toThrow(/Не удалось/);
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });

  it("persists mandatory auth flood waits and never retries a code automatically", async () => {
    await sendPhoneCode(107, "+998900000000");
    const client = mocks.clients[0];
    client.invoke.mockRejectedValueOnce({
      errorMessage: "FLOOD_WAIT_120",
      seconds: 120,
    });
    await expect(signInWithCode(107, "12345")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(client.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.at(-1)[1]).toEqual([107, 120]);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("pauses delivery before waiting for the worker barrier, then removes local authorization", async () => {
    let releaseWorker!: () => void;
    const barrier = new Promise<void>(resolve => {
      releaseWorker = resolve;
    });
    let reachedBarrier!: () => void;
    const reached = new Promise<void>(resolve => {
      reachedBarrier = resolve;
    });
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_lock(")) {
        reachedBarrier();
        await barrier;
      }
      return { rowCount: 1, rows: [] };
    });
    const logout = logoutSession(108);
    await reached;
    expect(mocks.txQuery.mock.calls[0][0]).toContain("AUTH_REQUIRED");
    expect(
      mocks.txQuery.mock.calls.some(call =>
        call[0].includes("DELETE FROM mtproto_sessions")
      )
    ).toBe(false);
    releaseWorker();
    await logout;
    expect(
      mocks.txQuery.mock.calls.some(call =>
        call[0].includes("DELETE FROM mtproto_sessions")
      )
    ).toBe(true);
    expect(mocks.txQuery.mock.calls.at(-1)[0]).toContain("pg_advisory_unlock");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
