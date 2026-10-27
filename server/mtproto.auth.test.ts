import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "./security/secrets";
import { LOGIN_PHONE_ERROR } from "../shared/loginPhone";
import { Api as RealApi } from "telegram/tl/index.js";
import {
  FloodWaitError,
  FloodTestPhoneWaitError,
  SlowModeWaitError,
  RPCMessageToError,
} from "telegram/errors/index.js";

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
    dcId = 4;
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
  getAuthStatus,
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
      if (sql.includes("AS server_now"))
        return {
          rowCount: 1,
          rows: mocks.throttleAllowed
            ? []
            : [
                {
                  server_now: new Date(),
                  sent_count: 1,
                  window_started_at: new Date(),
                  next_code_at: new Date(Date.now() + 60_000),
                },
              ],
        };
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
  it.each([FloodWaitError, FloodTestPhoneWaitError, SlowModeWaitError])(
    "persists the complete real SDK %s wait when requesting a code",
    async WaitError => {
      mocks.invoke.mockRejectedValueOnce(
        new WaitError({
          capture: 2090,
          request: new RealApi.contacts.ResolvePhone({ phone: "+19990000000" }),
        })
      );
      await expect(sendPhoneCode(140, "+19990000000")).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Telegram требует паузу 2090 сек. Автоматический повтор отключён.",
      });
      const flood = mocks.txQuery.mock.calls.find(([sql]) =>
        sql.startsWith("UPDATE mtproto_auth_controls")
      );
      expect(flood?.[0]).toContain("GREATEST(next_code_at");
      expect(flood?.[1]).toEqual([140, 2090]);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.records.size).toBe(0);
    }
  );

  it("persists a real premium wait returned by the SDK RPC converter", async () => {
    const error = RPCMessageToError(
      new RealApi.RpcError({
        errorCode: 420,
        errorMessage: "FLOOD_PREMIUM_WAIT_2090",
      }),
      new RealApi.contacts.ResolvePhone({ phone: "+19990000000" })
    );
    expect(error).toBeInstanceOf(FloodWaitError);
    await sendPhoneCode(141, "+19990000000");
    mocks.invoke.mockRejectedValueOnce(error);
    await expect(signInWithCode(141, "12345")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    const flood = mocks.txQuery.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE mtproto_auth_controls")
    );
    expect(flood?.[1]).toEqual([141, 2090]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.records.size).toBe(0);
  });
  it("corrects one completed GramJS DC redirect without enabling general retries", async () => {
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.clients[0].session.dcId = 2;
      throw new Error("Request was unsuccessful 1 time(s)");
    });
    await expect(sendPhoneCode(116, "+998900000000")).resolves.toEqual({
      phoneCodeHash: "synthetic-code-hash",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[0][0]).toBe(mocks.invoke.mock.calls[1][0]);
    expect(
      mocks.txQuery.mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO mtproto_auth_controls")
      )
    ).toHaveLength(1);
    expect(mocks.clients[0].options.requestRetries).toBe(1);
    expect(mocks.records.size).toBe(1);
  });

  it("never retries a generic unsuccessful request without a proven DC change", async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error("Request was unsuccessful 1 time(s)")
    );
    await expect(sendPhoneCode(117, "+998900000000")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.records.size).toBe(0);
  });

  it("does not retry flood waits even if the session DC has changed", async () => {
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.clients[0].session.dcId = 2;
      throw { errorMessage: "FLOOD_WAIT_120", seconds: 120 };
    });
    await expect(sendPhoneCode(118, "+998900000000")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(
      mocks.txQuery.mock.calls.find(([sql]) =>
        sql.startsWith("UPDATE mtproto_auth_controls")
      )?.[1]
    ).toEqual([118, 120]);
  });

  it("allows at most one redirect correction", async () => {
    mocks.invoke.mockImplementation(async () => {
      mocks.clients[0].session.dcId =
        mocks.invoke.mock.calls.length === 1 ? 2 : 1;
      throw new Error("Request was unsuccessful 1 time(s)");
    });
    await expect(sendPhoneCode(119, "+998900000000")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.records.size).toBe(0);
  });

  it("reuses a valid pending phone login without another connection or code request", async () => {
    await sendPhoneCode(120, "+998900000000");
    const encrypted = mocks.records.get(120)!.payload_encrypted;
    mocks.invoke.mockClear();
    mocks.connect.mockClear();
    mocks.txQuery.mockClear();
    await expect(sendPhoneCode(120, "+998 (90) 000-00-00")).resolves.toEqual({
      phoneCodeHash: "synthetic-code-hash",
      reused: true,
    });
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO mtproto_auth_controls")
      )
    ).toBe(false);
    expect(mocks.records.get(120)!.payload_encrypted).toBe(encrypted);
  });

  it("does not spend the code budget or destroy a pending login when connection fails", async () => {
    await sendPhoneCode(121, "+998900000000");
    const encrypted = mocks.records.get(121)!.payload_encrypted;
    mocks.txQuery.mockClear();
    mocks.invoke.mockClear();
    mocks.connect.mockRejectedValueOnce(new Error("synthetic-connect-failure"));
    await expect(
      sendPhoneCode(121, "+998900000000", true)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO mtproto_auth_controls")
      )
    ).toBe(false);
    expect(mocks.records.get(121)!.payload_encrypted).toBe(encrypted);
    expect(mocks.clients[1].destroy).toHaveBeenCalledTimes(1);
  });

  it("does not spend the code budget when the initial connection times out", async () => {
    vi.useFakeTimers();
    mocks.connect.mockImplementationOnce(() => new Promise(() => {}));
    const result = expect(
      sendPhoneCode(124, "+998900000000")
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_001);
    await result;
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO mtproto_auth_controls")
      )
    ).toBe(false);
    expect(mocks.records.size).toBe(0);
    expect(mocks.release).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a safe network error and preserves the code budget", async () => {
    mocks.connect.mockRejectedValueOnce(
      Object.assign(new Error("synthetic-private-network-detail"), {
        code: "ECONNRESET",
      })
    );
    await expect(sendPhoneCode(125, "+998900000000")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message:
        "Не удалось соединиться с Telegram. Проверьте состояние сервиса и повторите позже.",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(
      mocks.txQuery.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO mtproto_auth_controls")
      )
    ).toBe(false);
  });

  it("logs only the allowlisted failure stage and reason without raw error details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.invoke.mockRejectedValueOnce(
        Object.assign(new Error("synthetic-sensitive-error-detail"), {
          errorMessage: "synthetic-sensitive-rpc-detail",
        })
      );
      await expect(sendPhoneCode(127, "+998900000000")).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(warning).toHaveBeenCalledWith(
        JSON.stringify({
          event: "telegram_auth_failure",
          stage: "request_code",
          reason: "UNKNOWN",
        })
      );
      const output = JSON.stringify(warning.mock.calls);
      expect(output).not.toMatch(
        /synthetic|998900000000|phoneCodeHash|sessionString|payload_encrypted/
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("returns only masked resumable status and preserves the longer Telegram wait", async () => {
    mocks.invoke.mockResolvedValueOnce({
      phoneCodeHash: "synthetic-code-hash",
      type: { className: "auth.SentCodeTypeApp", length: 5 },
    });
    await sendPhoneCode(122, "+998900000000");
    const encrypted = mocks.records.get(122)!.payload_encrypted;
    const now = Date.now();
    mocks.query.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          server_now: new Date(now),
          sent_count: 3,
          window_started_at: new Date(now - 120_000),
          next_code_at: new Date(now + 3_600_000),
          payload_encrypted: encrypted,
          pending_expires_at: new Date(now + 240_000),
        },
      ],
    });
    mocks.txQuery.mockClear();
    const status = await getAuthStatus(122);
    expect(status).toMatchObject({
      serverNow: new Date(now).toISOString(),
      retryAt: new Date(now + 3_600_000).toISOString(),
      attemptsRemaining: 0,
      pending: {
        step: "code",
        codeAttemptsRemaining: 5,
        delivery: "telegram",
        codeLength: 5,
      },
    });
    expect(status.pending?.maskedPhone).toMatch(/^\+99•+00$/);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("998900000000");
    expect(serialized).not.toMatch(
      /synthetic|enc:v1|phoneCodeHash|sessionString|payload_encrypted/
    );
    expect(mocks.txQuery).not.toHaveBeenCalled();
    expect(mocks.records.get(122)!.payload_encrypted).toBe(encrypted);
  });

  it("reports an expired budget as available while withholding expired pending auth", async () => {
    const now = Date.now();
    mocks.query.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          server_now: new Date(now),
          sent_count: 3,
          window_started_at: new Date(now - 901_000),
          next_code_at: new Date(now - 1_000),
          payload_encrypted: "invalid",
          pending_expires_at: new Date(now - 1),
        },
      ],
    });
    await expect(getAuthStatus(123)).resolves.toEqual({
      serverNow: new Date(now).toISOString(),
      retryAt: null,
      attemptsRemaining: 3,
      pending: null,
    });
    expect(mocks.clients).toHaveLength(0);
    expect(mocks.txQuery).not.toHaveBeenCalled();
  });

  it("resumes the password step without consuming an auth attempt", async () => {
    await sendPhoneCode(126, "+998900000000");
    mocks.invoke.mockRejectedValueOnce({
      errorMessage: "SESSION_PASSWORD_NEEDED",
    });
    await expect(signInWithCode(126, "12345")).rejects.toMatchObject({
      message: "TWO_FACTOR_REQUIRED",
    });
    const encrypted = mocks.records.get(126)!.payload_encrypted;
    const now = Date.now();
    mocks.query.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          server_now: new Date(now),
          sent_count: 1,
          window_started_at: new Date(now),
          next_code_at: new Date(now + 60_000),
          payload_encrypted: encrypted,
          pending_expires_at: new Date(now + 240_000),
        },
      ],
    });
    mocks.txQuery.mockClear();
    await expect(getAuthStatus(126)).resolves.toMatchObject({
      pending: {
        step: "password",
        codeAttemptsRemaining: 4,
        delivery: "unknown",
        codeLength: null,
      },
    });
    expect(mocks.txQuery).not.toHaveBeenCalled();
    expect(mocks.records.get(126)!.payload_encrypted).toBe(encrypted);
  });

  it("sends and persists a formatted international phone canonically", async () => {
    await expect(
      sendPhoneCode(114, " +998\u00a0(90) 000-00.00 ")
    ).resolves.toEqual({ phoneCodeHash: "synthetic-code-hash" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SendCode",
        phoneNumber: "+998900000000",
      })
    );
    const pending = JSON.parse(
      decryptSecret(
        mocks.records.get(114)!.payload_encrypted,
        "mtproto-auth:114"
      )
    );
    expect(pending.phone).toBe("+998900000000");
    await signInWithCode(114, "12345");
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "SignIn",
        phoneNumber: "+998900000000",
        phoneCodeHash: "synthetic-code-hash",
      })
    );
  });

  it.each(["998900000000", "+998900000000 ext 1", "+998+900000000"])(
    "rejects an invalid phone before locks, throttles or Telegram: %s",
    async phone => {
      await expect(sendPhoneCode(115, phone)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: LOGIN_PHONE_ERROR,
      });
      expect(mocks.txQuery).not.toHaveBeenCalled();
      expect(mocks.clients).toHaveLength(0);
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.records.size).toBe(0);
    }
  );

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
