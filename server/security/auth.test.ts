import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../connection", () => ({ getPool: () => ({ query }) }));

import { createContext } from "../_core/context";
import {
  publicProcedure,
  protectedProcedure,
  adminProcedure,
  router,
} from "../_core/trpc";
import { authRouter } from "../auth";
import { hashOwnerPassword } from "./password";
import {
  createOwnerSession,
  readAuthenticatedUser,
  revokeRequestSession,
  signSessionToken,
  verifySessionToken,
  SESSION_TTL_MS,
} from "./sessions";

const owner = {
  id: 42,
  openId: "local-owner",
  role: "admin",
  name: "Owner",
  email: null,
  loginMethod: "password",
  createdAt: new Date(),
  lastSignedIn: new Date(),
};
const req = () =>
  ({
    headers: { origin: "https://sender.example" },
    ip: "127.0.0.1",
    socket: {},
  }) as any;
const res = () => ({ cookie: vi.fn(), clearCookie: vi.fn() }) as any;

beforeEach(() => {
  query.mockReset();
  vi.stubEnv("SESSION_SECRET", "12345678901234567890123456789012");
  vi.stubEnv("OWNER_PASSWORD_HASH", "test-hash");
  vi.stubEnv("APP_ORIGIN", "https://sender.example");
  vi.stubEnv("OWNER_OPEN_ID", "local-owner");
});

describe("persistent signed sessions", () => {
  it("does not assign an owner or touch the database to an anonymous request", async () => {
    const ctx = await createContext({
      req: req(),
      res: res(),
      info: {},
    } as any);
    expect(ctx.user).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects tampering, expiry, invalid formats and password rotation", () => {
    const now = Date.now();
    const token = signSessionToken(
      randomBytes(32).toString("base64url"),
      now + SESSION_TTL_MS
    );
    expect(verifySessionToken(token, now)).toMatchObject({
      expiresAt: now + SESSION_TTL_MS,
    });
    expect(verifySessionToken(token.slice(0, -1) + "!", now)).toBeNull();
    expect(verifySessionToken(token, now + SESSION_TTL_MS)).toBeNull();
    expect(verifySessionToken("fake-session", now)).toBeNull();
    vi.stubEnv("OWNER_PASSWORD_HASH", "rotated-hash");
    expect(verifySessionToken(token, now)).toBeNull();
  });
  it("takes the owner id from INSERT RETURNING and persists only the session hash", async () => {
    query
      .mockResolvedValueOnce({ rows: [owner] })
      .mockResolvedValue({ rows: [] });
    const session = await createOwnerSession();
    expect(session.user.id).toBe(42);
    expect(query.mock.calls[1][0]).toContain("INSERT INTO auth_sessions");
    expect(query.mock.calls[1][1][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(query.mock.calls)).not.toContain(session.token);
  });
  it("checks revocation/expiry in DB on every request and revokes by hash on logout", async () => {
    const token = signSessionToken(
      randomBytes(32).toString("base64url"),
      Date.now() + SESSION_TTL_MS
    );
    const request = { headers: { cookie: `app_session_id=${token}` } };
    query
      .mockResolvedValueOnce({ rows: [owner] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await readAuthenticatedUser(request)).toEqual(owner);
    expect(query.mock.calls[0][0]).toContain("s.revoked_at IS NULL");
    await revokeRequestSession(request);
    expect(query.mock.calls[1][0]).toContain("SET revoked_at=now()");
    expect(await readAuthenticatedUser(request)).toBeNull();
  });
});

describe("procedure access boundary", () => {
  const testRouter = router({
    public: publicProcedure.query(() => "public"),
    private: protectedProcedure.query(({ ctx }) => ctx.user.id),
    admin: adminProcedure.query(() => "admin"),
    mutation: protectedProcedure.mutation(() => "written"),
  });
  it("enforces anonymous and non-admin rejection", async () => {
    const anonymous = testRouter.createCaller({
      req: req(),
      res: res(),
      user: null,
    });
    expect(await anonymous.public()).toBe("public");
    await expect(anonymous.private()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const regular = testRouter.createCaller({
      req: req(),
      res: res(),
      user: { ...owner, role: "user" } as any,
    });
    expect(await regular.private()).toBe(42);
    await expect(regular.admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("requires same-origin even when the owner is authenticated", async () => {
    const request = req();
    request.headers.origin = "https://evil.example";
    await expect(
      testRouter
        .createCaller({ req: request, res: res(), user: owner as any })
        .mutation()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("login/logout route", () => {
  it("throttles before expensive password derivation or owner creation", async () => {
    query.mockResolvedValue({ rows: [{ attempts: 6 }] });
    await expect(
      authRouter
        .createCaller({ req: req(), res: res(), user: null })
        .login({ password: "invalid" })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong passwords without creating a session", async () => {
    vi.stubEnv(
      "OWNER_PASSWORD_HASH",
      await hashOwnerPassword("the-real-long-password")
    );
    query.mockResolvedValue({ rows: [{ attempts: 1 }] });
    await expect(
      authRouter
        .createCaller({ req: req(), res: res(), user: null })
        .login({ password: "invalid" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("sets an httpOnly, strict, secure cookie after valid authentication", async () => {
    const password = "the-real-long-password";
    vi.stubEnv("OWNER_PASSWORD_HASH", await hashOwnerPassword(password));
    query
      .mockResolvedValueOnce({ rows: [{ attempts: 1 }] })
      .mockResolvedValueOnce({ rows: [owner] })
      .mockResolvedValue({ rows: [] });
    const response = res();
    const result = await authRouter
      .createCaller({ req: req(), res: response, user: null })
      .login({ password });
    expect(result.user.id).toBe(42);
    expect(response.cookie).toHaveBeenCalledWith(
      "app_session_id",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        maxAge: SESSION_TTL_MS,
      })
    );
  });
  it("clears the cookie even for already logged-out callers", async () => {
    const response = res();
    expect(
      await authRouter
        .createCaller({ req: req(), res: response, user: null })
        .logout()
    ).toEqual({ success: true });
    expect(response.clearCookie).toHaveBeenCalledWith(
      "app_session_id",
      expect.objectContaining({ httpOnly: true, sameSite: "strict" })
    );
  });
});
