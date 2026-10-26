import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "./secrets";
import { hashOwnerPassword, verifyOwnerPassword } from "./password";
import { appOrigin, assertSameOrigin } from "./origin";
import { redactSensitive, redactText } from "./redaction";
import { botSettingsDto, mtprotoSessionDto } from "./dto";
import { getSessionCookieOptions } from "../_core/cookies";
import { databasePoolConfig } from "../connection";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("APP_ORIGIN", "https://sender.example");
});

describe("credential encryption", () => {
  it("uses fresh nonces and rejects tampering, wrong owners, and wrong keys", () => {
    const first = encryptSecret("sensitive-credential", "bot:12");
    const second = encryptSecret("sensitive-credential", "bot:12");
    expect(first).not.toBe(second);
    expect(first).not.toContain("sensitive-credential");
    expect(decryptSecret(first, "bot:12")).toBe("sensitive-credential");
    expect(() => decryptSecret(first, "bot:13")).toThrow();
    const parts = first.split(":");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), "bot:12")).toThrow();
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptSecret(first, "bot:12")).toThrow();
  });
  it("fails closed on unencrypted legacy values and missing keys", () => {
    expect(() => decryptSecret("legacy-session", "mtproto:12")).toThrow(
      /Legacy/
    );
    vi.stubEnv("ENCRYPTION_KEY", "short");
    expect(() => encryptSecret("secret", "bot:12")).toThrow(/32 bytes/);
  });
});

describe("password authentication primitives", () => {
  it("hashes with distinct salts and verifies without storing plaintext", async () => {
    const password = "a-long-owner-passphrase";
    const first = await hashOwnerPassword(password);
    const second = await hashOwnerPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyOwnerPassword(password, first)).toBe(true);
    expect(await verifyOwnerPassword("wrong-password", first)).toBe(false);
    await expect(
      verifyOwnerPassword(password, first.replace("16384", "999999999"))
    ).rejects.toThrow();
  });
});

describe("origin and cookie boundary", () => {
  it("rejects cross-site, missing, null, and forged origins", () => {
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "https://sender.example.evil.example",
    ]) {
      expect(() => assertSameOrigin({ headers: { origin } })).toThrow(/origin/);
    }
    expect(() =>
      assertSameOrigin({
        headers: {
          origin: "https://sender.example",
          "sec-fetch-site": "cross-site",
        },
      })
    ).toThrow();
    expect(() =>
      assertSameOrigin({ headers: { origin: "https://sender.example" } })
    ).not.toThrow();
  });
  it("does not trust spoofed forwarding headers or allow remote plaintext HTTP", () => {
    const req = {
      protocol: "http",
      headers: { "x-forwarded-proto": "http" },
    } as any;
    expect(getSessionCookieOptions(req)).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: true,
    });
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
    expect(getSessionCookieOptions(req).secure).toBe(false);
    vi.stubEnv("APP_ORIGIN", "http://sender.example");
    expect(() => appOrigin()).toThrow(/HTTPS/);
  });
});

describe("database connection policy", () => {
  it("fails closed without PostgreSQL and requires certificate validation remotely", () => {
    expect(() => databasePoolConfig({})).toThrow(/required/);
    expect(() =>
      databasePoolConfig({ DATABASE_URL: "mysql://localhost/test" })
    ).toThrow(/PostgreSQL/);
    const config = databasePoolConfig({
      DATABASE_URL: "postgres://owner:secret@db.example/test?sslmode=no-verify",
    });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
    expect(() =>
      databasePoolConfig({
        DATABASE_URL: "postgres://db.example/test",
        DATABASE_SSL: "disable",
      })
    ).toThrow(/loopback/);
    expect(
      databasePoolConfig({
        DATABASE_URL: "postgres://127.0.0.1/test",
        DATABASE_SSL: "disable",
      }).ssl
    ).toBe(false);
  });
});

describe("redaction and public DTOs", () => {
  it("never returns stored credentials in settings summaries", () => {
    const bot = botSettingsDto({
      id: 1,
      botToken: "SECRET_TOKEN",
      userId: 12,
      isValid: true,
    } as any);
    const session = mtprotoSessionDto({
      id: 2,
      sessionString: "SECRET_SESSION",
      userId: 12,
      isActive: true,
    } as any);
    expect(JSON.stringify({ bot, session })).not.toContain("SECRET");
    expect(bot).not.toHaveProperty("botToken");
    expect(session).not.toHaveProperty("sessionString");
  });
  it("redacts login codes, auth headers and tokens nested in diagnostic objects", () => {
    const result = redactSensitive({
      code: "12345",
      body: {
        password: "pass",
        sessionString: "session",
        phoneCodeHash: "hash",
      },
      authorization: "Bearer secret",
      safe: "okay",
    });
    expect(JSON.stringify(result)).not.toContain("12345");
    expect(result).toMatchObject({ safe: "okay", code: "[redacted]" });
    expect(
      redactText("request /bot123456:abcdefghijklmnoABCDEFGHIJK/sendMessage")
    ).not.toContain("abcdefgh");
  });
});
