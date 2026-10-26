import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
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
import { closePool, databasePoolConfig, getPool } from "./connection";
import * as db from "./db";
import * as identity from "./senderIdentity";
import { appRouter } from "./routers";
import { tickAutomations } from "./automation";
import { registerTelegramWebhook } from "./telegramWebhook";
import { telegramTransport } from "./telegramTransport";
import { setContactPermission } from "./delivery";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("adversarial integration review regression", () => {
  const schema = `review_test_${randomUUID().replaceAll("-", "")}`;
  const ownerId = 85001;
  const tokenA = "12345678:synthetic_token_A_never_sent_to_Telegram";
  const tokenB = "87654321:synthetic_token_B_never_sent_to_Telegram";
  const webhookKey = "synthetic-webhook-hmac-key-32-characters";
  let admin: Pool, pool: Pool, server: Server, origin: string;
  let owner: ReturnType<typeof appRouter.createCaller>;
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
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 29).toString("base64"));
    vi.stubEnv("LIVE_SEND_ENABLED", "true"); // Only synthetic transports / enqueue; no worker dispatch.
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", webhookKey);
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3037");
    pool = getPool();
    await pool.query(
      "CREATE TABLE app_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())"
    );
    await pool.query(
      (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
        '"public".',
        `"${schema}".`
      )
    );
    for (const file of (await readdir("migrations"))
      .filter(name => name.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    owner = appRouter.createCaller({
      user: {
        id: ownerId,
        openId: `owner-${ownerId}`,
        name: "Synthetic owner",
        role: "admin",
        email: null,
        loginMethod: "password",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: {
        headers: { origin: "http://127.0.0.1:3037" },
        ip: "127.0.0.1",
      } as any,
      res: {} as any,
    });
    const app = express();
    app.use(express.json());
    registerTelegramWebhook(app);
    server = await new Promise<Server>(resolve => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query(
      "TRUNCATE delivery_worker_heartbeats,delivery_resolutions,delivery_attempts,deliveries,delivery_campaigns,contact_delivery_controls,sender_controls,contact_permissions,telegram_subscription_cursors,automation_events,automation_rules,campaign_snapshots,audit_events,broadcasts,recipient_lists,bot_settings RESTART IDENTITY CASCADE"
    );
    await db.upsertBotSettings(ownerId, {
      botToken: tokenA,
      botUsername: "this_test_bot",
      botName: "Synthetic bot A",
      isValid: true,
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server)
      await new Promise<void>(resolve => server.close(() => resolve()));
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });
  async function subscribe(text: string, eventDate: number) {
    const secret = createHmac("sha256", webhookKey)
      .update(`${ownerId}:${tokenA}`)
      .digest("hex");
    return fetch(`${origin}/api/telegram/${ownerId}/updates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": secret,
      },
      body: JSON.stringify({
        update_id: 1,
        message: { date: eventDate, text, chat: { id: 101, type: "private" } },
      }),
    });
  }

  it("never authorizes a delayed subscribe older than a newer manual opt-out", async () => {
    await setContactPermission({
      ownerId,
      kind: "bot",
      recipient: "101",
      allowed: false,
      source: "newer-manual-optout",
    });
    expect(
      (await subscribe("/subscribe", Math.floor(Date.now() / 1000) - 120))
        .status
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT allowed,suppressed_at FROM contact_permissions WHERE owner_id=$1",
          [ownerId]
        )
      ).rows[0]
    ).toMatchObject({ allowed: false, suppressed_at: expect.any(Date) });
  });

  it("accepts a genuinely newer explicit subscribe after an older opt-out", async () => {
    await setContactPermission({
      ownerId,
      kind: "bot",
      recipient: "101",
      allowed: false,
      source: "older-manual-optout",
    });
    await pool.query(
      "UPDATE contact_permissions SET suppressed_at=now()-interval '5 minutes',updated_at=now()-interval '5 minutes' WHERE owner_id=$1",
      [ownerId]
    );
    expect(
      (await subscribe("/subscribe", Math.floor(Date.now() / 1000) - 10)).status
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT allowed,suppressed_at FROM contact_permissions WHERE owner_id=$1",
          [ownerId]
        )
      ).rows[0]
    ).toMatchObject({ allowed: true, suppressed_at: null });
  });

  it("ignores a subscribe command explicitly addressed to a different bot", async () => {
    expect(
      (await subscribe("/subscribe@another_bot", Math.floor(Date.now() / 1000)))
        .status
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT * FROM contact_permissions WHERE owner_id=$1",
          [ownerId]
        )
      ).rowCount
    ).toBe(0);
  });

  it("rejects a changed approved sender before making any Telegram request", async () => {
    await db.upsertBotSettings(ownerId, {
      botToken: tokenB,
      botUsername: "other_test_bot",
      isValid: true,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden in test"));
    await expect(
      telegramTransport.send({
        ownerId,
        kind: "bot",
        recipient: "chat:101",
        message: "Synthetic",
        parseMode: null,
        deliveryId: "1",
        randomId: "1",
        signal: new AbortController().signal,
        senderFingerprint: createHash("sha256").update(tokenA).digest("hex"),
      })
    ).rejects.toMatchObject({
      category: "auth",
      code: "APPROVED_SENDER_CHANGED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a changed sender read when creating a campaign from an approved automation", async () => {
    const list = await db.createRecipientList({
      userId: ownerId,
      name: "Synthetic",
      chatIds: '["101"]',
      totalCount: 1,
      fileType: "json",
    });
    const rule = await owner.automation.create({
      name: "Approved sender A",
      transport: "bot",
      listId: list.id,
      message: "Synthetic",
      parseMode: "None",
      trigger: "schedule",
      intervalMinutes: 5,
      approved: true,
      isDryRun: false,
      requestKey: "sender-race",
    });
    await pool.query(
      "INSERT INTO automation_events(rule_id,owner_id,event_key) VALUES($1,$2,$3)",
      [rule.id, ownerId, "synthetic:race"]
    );
    const original = identity.senderFingerprint;
    let changed = false;
    vi.spyOn(identity, "senderFingerprint").mockImplementation(
      async (owner, kind) => {
        if (!changed) {
          changed = true;
          return original(owner, kind);
        }
        // Force a changed read without mutating config while the scheduler holds its rule lock.
        return createHash("sha256").update(tokenB).digest("hex");
      }
    );
    await tickAutomations();
    const event = (
      await pool.query(
        "SELECT status FROM automation_events WHERE rule_id=$1",
        [rule.id]
      )
    ).rows[0];
    expect(event.status).toBe("review_required");
    expect(
      (await pool.query("SELECT * FROM delivery_campaigns")).rowCount
    ).toBe(0);
  });

  it("does not carry the previous bot subscription permission into a replacement bot", async () => {
    await setContactPermission({
      ownerId,
      kind: "bot",
      recipient: "101",
      allowed: true,
      source: "bot-A-optin",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 87654321,
            first_name: "Synthetic B",
            username: "other_test_bot",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await owner.bot.validate({ token: tokenB });
    expect(
      (
        await pool.query(
          "SELECT allowed FROM contact_permissions WHERE owner_id=$1",
          [ownerId]
        )
      ).rows[0].allowed
    ).toBe(false);
  });

  it("does not declare a worker ready when its fresh heartbeat records a failed work loop", async () => {
    await pool.query(
      "INSERT INTO delivery_worker_heartbeats(worker_id,live_send_enabled,last_error,last_success_at) VALUES('synthetic-failed-worker',true,'WORKER_TICK_FAILED',now())"
    );
    expect(await owner.operations.status()).toMatchObject({
      database: true,
      ready: false,
    });
    await pool.query("UPDATE delivery_worker_heartbeats SET last_error=NULL");
    expect(await owner.operations.status()).toMatchObject({
      database: true,
      ready: true,
    });
    await pool.query(
      "UPDATE delivery_worker_heartbeats SET last_success_at=now()-interval '2 minutes'"
    );
    expect(await owner.operations.status()).toMatchObject({
      database: true,
      ready: false,
    });
  });
});
