import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
import { closePool, databasePoolConfig, getPool } from "../connection";
import {
  createBroadcast,
  createMtprotoBroadcast,
  createRecipientList,
  getBotSettings,
  getMtprotoSession,
  getRecipientList,
  migrateLegacySecrets,
  upsertBotSettings,
  upsertMtprotoSession,
} from "../db";
import { authRouter } from "../auth";
import { createContext } from "../_core/context";
import {
  createOwnerSession,
  readAuthenticatedUser,
  verifySessionToken,
} from "./sessions";
import { hashOwnerPassword } from "./password";

// Explicit opt-in. This suite creates and drops only its own randomly named schema.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("security and ownership on PostgreSQL", () => {
  const schema = `security_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  const ownerPassword = "local-test-owner-passphrase";

  beforeAll(async () => {
    const config = databasePoolConfig({
      ...process.env,
      DATABASE_URL: url,
      DATABASE_SSL: "disable",
    });
    admin = new Pool({ ...config, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = new URL(url!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 19).toString("base64"));
    vi.stubEnv("SESSION_SECRET", "isolated-test-session-secret-32-characters");
    vi.stubEnv("OWNER_PASSWORD_HASH", await hashOwnerPassword(ownerPassword));
    vi.stubEnv("OWNER_OPEN_ID", "integration-owner");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3131");
    pool = getPool();
    const base = (
      await readFile(
        new URL("../../drizzle/0000_massive_chamber.sql", import.meta.url),
        "utf8"
      )
    ).replaceAll('"public".', `"${schema}".`);
    await pool.query(base);
    for (const file of (
      await readdir(new URL("../../migrations/", import.meta.url))
    )
      .filter(file => file.endsWith(".sql"))
      .sort()) {
      await pool.query(
        await readFile(
          new URL(`../../migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE auth_sessions,auth_login_attempts,users,bot_settings,mtproto_sessions,recipient_lists,broadcasts,mtproto_broadcasts,audience_sources,automation_rules,contact_permissions,sender_controls,audit_events,campaign_snapshots,telegram_subscription_cursors RESTART IDENTITY CASCADE"
    );
  });

  afterAll(async () => {
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  function request(cookie?: string) {
    return {
      headers: {
        origin: "http://127.0.0.1:3131",
        ...(cookie ? { cookie } : {}),
      },
      ip: "127.0.0.1",
      socket: {},
    } as any;
  }

  async function seedSenderScope(kind: "bot" | "mtproto" = "bot", owner = 12) {
    await pool.query(
      "INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at) VALUES($1,$2,'chat:101',true,'explicit-consent',NULL),($1,$2,'chat:102',false,'explicit-optout','2026-01-01'),($3,$2,'chat:101',true,'other-owner',NULL)",
      [owner, kind, owner + 1]
    );
    await pool.query(
      "INSERT INTO audience_sources(owner_id,list_id,name,transport,request_key,request_hash,secret_hash,encrypted_secret) VALUES($1,1,'Synthetic CRM',$2,'key','hash','hash','encrypted')",
      [owner, kind]
    );
    await pool.query(
      "INSERT INTO automation_rules(owner_id,name,transport,list_id,recipients,message,parse_mode,delay_seconds,trigger,interval_minutes) VALUES($1,'Synthetic rule',$2,1,'[]','test','None',3,'schedule',60)",
      [owner, kind]
    );
    if (kind === "bot")
      await pool.query(
        "INSERT INTO telegram_subscription_cursors(owner_id,recipient,last_update_id,last_event_date) VALUES($1,'chat:101',100,1000),($2,'chat:101',100,1000)",
        [owner, owner + 1]
      );
    await pool.query(
      "INSERT INTO sender_controls(sender_key,owner_id,kind) VALUES($1,$2,$3)",
      [`${owner}:${kind}`, owner, kind]
    );
    for (const [index, status] of [
      "queued",
      "running",
      "completed",
    ].entries()) {
      await pool.query(
        "INSERT INTO delivery_campaigns(owner_id,kind,broadcast_id,sender_key,snapshot_hash,message,delay_seconds,status) VALUES($1,$2,$3,$4,'hash','test',3,$5)",
        [owner, kind, index + 1, `${owner}:${kind}`, status]
      );
    }
  }

  async function senderScope(kind: "bot" | "mtproto" = "bot", owner = 12) {
    return {
      permissions: (
        await pool.query(
          "SELECT recipient,allowed,source,suppressed_at FROM contact_permissions WHERE owner_id=$1 AND kind=$2 ORDER BY recipient",
          [owner, kind]
        )
      ).rows,
      source: (
        await pool.query(
          "SELECT revoked_at FROM audience_sources WHERE owner_id=$1 AND transport=$2",
          [owner, kind]
        )
      ).rows[0],
      rule: (
        await pool.query(
          "SELECT enabled FROM automation_rules WHERE owner_id=$1 AND transport=$2",
          [owner, kind]
        )
      ).rows[0],
      campaigns: (
        await pool.query(
          "SELECT status FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 ORDER BY broadcast_id",
          [owner, kind]
        )
      ).rows.map(row => row.status),
      cursors: (
        await pool.query(
          "SELECT recipient,last_update_id,last_event_date FROM telegram_subscription_cursors WHERE owner_id=$1 ORDER BY recipient",
          [owner]
        )
      ).rows,
    };
  }

  it("authenticates a DB-derived owner, persists a hashed session and revokes logout immediately", async () => {
    await pool.query(
      `INSERT INTO users ("openId",name) VALUES ('other-user','Other user')`
    );
    const response = { cookie: vi.fn(), clearCookie: vi.fn() } as any;
    const ctx = await createContext({
      req: request(),
      res: response,
      info: {},
    } as any);
    expect(ctx.user).toBeNull();
    const login = await authRouter
      .createCaller(ctx)
      .login({ password: ownerPassword });
    expect(login.user.id).toBe(2);
    const token = response.cookie.mock.calls[0][1] as string;
    const verified = verifySessionToken(token)!;
    const stored = await pool.query(
      "SELECT session_hash,user_id FROM auth_sessions"
    );
    expect(stored.rows).toEqual([{ session_hash: verified.hash, user_id: 2 }]);
    const cookie = `app_session_id=${token}`;
    expect((await readAuthenticatedUser(request(cookie)))?.id).toBe(2);
    const logoutCtx = await createContext({
      req: request(cookie),
      res: response,
      info: {},
    } as any);
    await authRouter.createCaller(logoutCtx).logout();
    expect(await readAuthenticatedUser(request(cookie))).toBeNull();
    expect(
      (await pool.query("SELECT revoked_at FROM auth_sessions")).rows[0]
        .revoked_at
    ).toBeInstanceOf(Date);
    expect(response.clearCookie).toHaveBeenCalled();
  });

  it("enforces the attempt budget atomically across concurrent login requests", async () => {
    const caller = authRouter.createCaller({
      req: request(),
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as any,
      user: null,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => caller.login({ password: "wrong" }))
    );
    const errors = results.map(r =>
      r.status === "rejected" ? r.reason.code : "unexpected-success"
    );
    expect(errors.filter(code => code === "UNAUTHORIZED")).toHaveLength(5);
    expect(errors.filter(code => code === "TOO_MANY_REQUESTS")).toHaveLength(3);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM auth_sessions"))
        .rows[0].count
    ).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM users")).rows[0]
        .count
    ).toBe(0);
  });

  it("stores only AEAD ciphertext and atomically upserts a single credential row", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertBotSettings(12, {
          botToken: `test-secret-token-${i}`,
          isValid: true,
        })
      )
    );
    const stored = await pool.query(
      'SELECT "botToken" FROM bot_settings WHERE "userId"=12'
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].botToken).toMatch(/^enc:v1:/);
    expect(stored.rows[0].botToken).not.toContain("test-secret-token");
    expect((await getBotSettings(12))?.botToken).toMatch(
      /^test-secret-token-\d+$/
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertMtprotoSession(12, {
          sessionString: `session-${i}`,
          isActive: true,
        })
      )
    );
    const sessions = await pool.query(
      'SELECT "sessionString" FROM mtproto_sessions WHERE "userId"=12'
    );
    expect(sessions.rowCount).toBe(1);
    expect(sessions.rows[0].sessionString).toMatch(/^enc:v1:/);
    expect((await getMtprotoSession(12))?.sessionString).toMatch(
      /^session-\d+$/
    );
    expect(await getBotSettings(13)).toBeNull();
  });

  it("rejects plaintext until explicit migration, and refuses credentials copied to another owner", async () => {
    await pool.query(
      'INSERT INTO bot_settings ("userId","botToken") VALUES ($1,$2)',
      [7, "legacy-bot-secret"]
    );
    await pool.query(
      'INSERT INTO mtproto_sessions ("userId","sessionString") VALUES ($1,$2)',
      [7, "legacy-session-secret"]
    );
    await expect(getBotSettings(7)).rejects.toThrow(/Legacy/);
    await expect(getMtprotoSession(7)).rejects.toThrow(/Legacy/);
    expect(await migrateLegacySecrets()).toEqual({
      botTokens: 1,
      mtprotoSessions: 1,
    });
    expect((await getBotSettings(7))?.botToken).toBe("legacy-bot-secret");
    expect((await getMtprotoSession(7))?.sessionString).toBe(
      "legacy-session-secret"
    );
    expect(await migrateLegacySecrets()).toEqual({
      botTokens: 0,
      mtprotoSessions: 0,
    });
    await pool.query(
      'INSERT INTO bot_settings ("userId","botToken") SELECT 8,"botToken" FROM bot_settings WHERE "userId"=7'
    );
    await expect(getBotSettings(8)).rejects.toThrow(/Cannot decrypt/);
  });

  it("does not grant an initial sender the permissions imported before it was connected", async () => {
    await seedSenderScope();
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-first-token",
      isValid: true,
    });
    const scope = await senderScope();
    expect(scope.permissions.every(row => !row.allowed)).toBe(true);
    expect(scope.source.revoked_at).toBeInstanceOf(Date);
    expect(scope.rule.enabled).toBe(false);
    expect(scope.campaigns).toEqual([
      "review_required",
      "review_required",
      "completed",
    ]);
  });

  it("preserves consent on same-bot key rotation while quarantining the old approved queue", async () => {
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-old-token",
      isValid: true,
    });
    await seedSenderScope();
    const before = await senderScope();
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-rotated-token",
      isValid: true,
    });
    const after = await senderScope();
    expect(after.permissions).toEqual(before.permissions);
    expect(after.source.revoked_at).toBeNull();
    expect(after.rule.enabled).toBe(true);
    expect(after.cursors).toEqual(before.cursors);
    expect(after.campaigns).toEqual([
      "review_required",
      "review_required",
      "completed",
    ]);
    await pool.query(
      "UPDATE delivery_campaigns SET status='queued' WHERE broadcast_id=1"
    );
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-rotated-token",
      botName: "Updated display name",
      isValid: true,
    });
    expect((await senderScope()).campaigns[0]).toBe("queued");
  });

  it("revokes old bot identity consent and capabilities in its own owner and transport only", async () => {
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-old-token",
      isValid: true,
    });
    await seedSenderScope();
    await pool.query(
      "INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source) VALUES(12,'mtproto','chat:101',true,'other-transport')"
    );
    const before = await senderScope();
    await upsertBotSettings(12, {
      botToken: "2002:synthetic-other-bot-token",
      isValid: true,
    });
    const after = await senderScope();
    expect(
      after.permissions.every(
        row => !row.allowed && row.source === "sender:identity_changed"
      )
    ).toBe(true);
    expect(after.permissions[1].suppressed_at).toEqual(
      before.permissions[1].suppressed_at
    );
    expect(after.source.revoked_at).toBeInstanceOf(Date);
    expect(after.rule.enabled).toBe(false);
    expect(after.campaigns).toEqual([
      "review_required",
      "review_required",
      "completed",
    ]);
    expect(after.cursors).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM telegram_subscription_cursors WHERE owner_id=13"
        )
      ).rowCount
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT allowed FROM contact_permissions WHERE owner_id=13 OR kind='mtproto'"
        )
      ).rows.every(row => row.allowed)
    ).toBe(true);
  });

  it("pins MTProto consent to Telegram identity while allowing same-account session rotation", async () => {
    await upsertMtprotoSession(12, {
      telegramId: "1001",
      sessionString: "synthetic-first-session",
      isActive: true,
    });
    await seedSenderScope("mtproto");
    const before = await senderScope("mtproto");
    await upsertMtprotoSession(12, {
      telegramId: "1001",
      sessionString: "synthetic-rotated-session",
      isActive: true,
    });
    const rotated = await senderScope("mtproto");
    expect(rotated.permissions).toEqual(before.permissions);
    expect(rotated.source.revoked_at).toBeNull();
    expect(rotated.campaigns).toEqual([
      "review_required",
      "review_required",
      "completed",
    ]);
    await upsertMtprotoSession(12, {
      telegramId: "2002",
      sessionString: "synthetic-other-account-session",
      isActive: true,
    });
    const replaced = await senderScope("mtproto");
    expect(replaced.permissions.every(row => !row.allowed)).toBe(true);
    expect(replaced.source.revoked_at).toBeInstanceOf(Date);
    expect(replaced.rule.enabled).toBe(false);
    expect((await getMtprotoSession(12))?.telegramId).toBe("2002");
  });

  it("rolls back credential replacement and every revocation if credential storage fails", async () => {
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-original-token",
      isValid: true,
    });
    await seedSenderScope();
    const before = await senderScope();
    const credentialBefore = (
      await pool.query('SELECT "botToken" FROM bot_settings WHERE "userId"=12')
    ).rows[0].botToken;
    const auditBefore = (
      await pool.query("SELECT count(*)::int AS count FROM audit_events")
    ).rows[0].count;
    await expect(
      upsertBotSettings(12, {
        botToken: "2002:synthetic-failing-token",
        botName: "x".repeat(129),
        isValid: true,
      })
    ).rejects.toThrow();
    expect(await senderScope()).toEqual(before);
    expect(
      (
        await pool.query(
          'SELECT "botToken" FROM bot_settings WHERE "userId"=12'
        )
      ).rows[0].botToken
    ).toBe(credentialBefore);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM audit_events"))
        .rows[0].count
    ).toBe(auditBefore);
  });

  it("waits for the worker sender lock before replacing credentials", async () => {
    await upsertBotSettings(12, {
      botToken: "1001:synthetic-original-token",
      isValid: true,
    });
    const worker = await pool.connect();
    let replacement: Promise<void> | undefined;
    try {
      await worker.query(
        "SELECT pg_advisory_lock(hashtextextended('tg-sender:12:bot',0))"
      );
      replacement = upsertBotSettings(12, {
        botToken: "1001:synthetic-next-token",
        isValid: true,
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1"
            )
          ).rowCount! > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await getBotSettings(12))?.botToken).toBe(
        "1001:synthetic-original-token"
      );
    } finally {
      await worker.query(
        "SELECT pg_advisory_unlock(hashtextextended('tg-sender:12:bot',0))"
      );
      worker.release();
      await replacement;
    }
    expect((await getBotSettings(12))?.botToken).toBe(
      "1001:synthetic-next-token"
    );
  });

  it("returns the exact inserted list and campaign under concurrent creation", async () => {
    const lists = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        createRecipientList({
          userId: 42,
          name: `list-${i}`,
          chatIds: "[]",
          totalCount: 0,
          fileType: "csv",
        })
      )
    );
    expect(lists.map(row => row.name)).toEqual(
      Array.from({ length: 16 }, (_, i) => `list-${i}`)
    );
    expect(new Set(lists.map(row => row.id)).size).toBe(16);
    expect(await getRecipientList(lists[0].id, 99)).toBeNull();
    const input = {
      userId: 42,
      message: "test",
      parseMode: "None" as const,
      delaySeconds: 1,
      isDryRun: true,
      totalRecipients: 0,
    };
    const bots = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createBroadcast({ ...input, name: `bot-${i}` })
      )
    );
    const mtproto = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createMtprotoBroadcast({ ...input, name: `mtproto-${i}` })
      )
    );
    expect(bots.map(row => row.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `bot-${i}`)
    );
    expect(mtproto.map(row => row.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `mtproto-${i}`)
    );
  });

  it("does not accept a signed session after its DB expiry", async () => {
    const session = await createOwnerSession();
    await pool.query(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 second'"
    );
    expect(
      await readAuthenticatedUser(request(`app_session_id=${session.token}`))
    ).toBeNull();
  });
});
