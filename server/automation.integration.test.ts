import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import express from "express";
import type { Server } from "node:http";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { getPool, closePool, databasePoolConfig } from "./connection";
import { appRouter } from "./routers";
import { registerAutomationWebhook, tickAutomations } from "./automation";
import { runWorkerOnce } from "./delivery";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Application workflows on isolated PostgreSQL", () => {
  const schema = `workflow_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, server: Server, origin: string;
  let owner: ReturnType<typeof appRouter.createCaller>;
  const context = (id: number | null) => ({
    req: {
      headers: { origin: "http://127.0.0.1:3037" },
      ip: "127.0.0.1",
    } as any,
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as any,
    user: id
      ? {
          id,
          openId: `owner-${id}`,
          name: "Test",
          email: null,
          role: "admin" as const,
          loginMethod: "password",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        }
      : null,
  });
  beforeAll(async () => {
    admin = new Pool(
      databasePoolConfig({
        ...process.env,
        DATABASE_URL: url,
        DATABASE_SSL: "disable",
      })
    );
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(url!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    vi.stubEnv("LIVE_SEND_ENABLED", "false");
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3037");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 23).toString("base64"));
    vi.stubEnv("SESSION_SECRET", "integration-test-session-key-32-characters");
    pool = getPool();
    await pool.query(
      (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
        '"public".',
        `"${schema}".`
      )
    );
    for (const file of (await readdir("migrations"))
      .filter(f => f.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    owner = appRouter.createCaller(context(17));
    const app = express();
    app.use(express.json());
    registerAutomationWebhook(app);
    server = await new Promise<Server>(resolve => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()));
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  async function audience(transport: "bot" | "mtproto" = "bot") {
    return owner.recipients.upload({
      name: "Approved test audience",
      content: '["-1001234567890","123456789","@ExampleUser"]',
      fileType: "json",
      recipientType: "auto",
      permissionTransport: transport,
      consentConfirmed: true,
      consentSource: "Synthetic opt-in test",
    });
  }
  it("denies anonymous API and stale draft overwrites", async () => {
    await expect(
      appRouter.createCaller(context(null)).recipients.list()
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const first = await owner.draft.save({
      key: "bot",
      message: "saved",
      parseMode: "None",
      expectedVersion: 0,
    });
    expect(first.version).toBe(1);
    await expect(
      owner.draft.save({
        key: "bot",
        message: "stale",
        parseMode: "None",
        expectedVersion: 0,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await owner.draft.get({ key: "bot" }))?.message).toBe("saved");
  });
  it("preserves numeric IDs and sender permission scope and reimport suppression", async () => {
    const list = await audience();
    expect(JSON.parse(list.chatIds)).toEqual([
      "-1001234567890",
      "123456789",
      "@exampleuser",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM contact_permissions WHERE owner_id=17 AND kind='mtproto'"
        )
      ).rows[0].n
    ).toBe(0);
    await owner.recipients.setPermission({
      transport: "bot",
      recipient: "123456789",
      allowed: false,
      source: "Explicit test unsubscribe",
    });
    await audience();
    expect(
      (
        await pool.query(
          "SELECT allowed,suppressed_at FROM contact_permissions WHERE owner_id=17 AND kind='bot' AND recipient='chat:123456789'"
        )
      ).rows[0]
    ).toMatchObject({ allowed: false, suppressed_at: expect.any(Date) });
  });
  it("creates and launches idempotently and never calls Telegram in dry-run", async () => {
    const list = await audience();
    const input = {
      name: "Snapshot test",
      message: "Test message",
      parseMode: "None" as const,
      delaySeconds: 1,
      isDryRun: true,
      recipientListId: list.id,
      requestKey: "same-create",
    };
    const [a, b] = await Promise.all([
      owner.broadcast.create(input),
      owner.broadcast.create(input),
    ]);
    expect(a.id).toBe(b.id);
    await expect(
      owner.broadcast.create({ ...input, delaySeconds: 2 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await Promise.all([
      owner.broadcast.launch({ id: a.id }),
      owner.broadcast.launch({ id: a.id }),
    ]);
    const send = vi.fn();
    for (let i = 0; i < 5; i++)
      await runWorkerOnce({
        pool,
        transport: { send },
        liveSendEnabled: false,
      });
    expect(send).not.toHaveBeenCalled();
    const progress = await owner.broadcast.getProgress({ id: a.id });
    expect(progress).toMatchObject({
      status: "completed",
      dryRun: 2,
      suppressed: 1,
      sent: 0,
    });
    expect(
      await appRouter
        .createCaller(context(18))
        .broadcast.getProgress({ id: a.id })
    ).toBeNull();
    const page = await owner.broadcast.getDeliveryPage({
      id: a.id,
      limit: 2,
      offset: 0,
    });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });
  it("creates one approved webhook rule, rejects invalid authorization and deduplicates events", async () => {
    const list = await audience();
    const input = {
      name: "Webhook rule",
      transport: "bot" as const,
      listId: list.id,
      message: "Approved body",
      parseMode: "None" as const,
      trigger: "webhook" as const,
      approved: true as const,
      isDryRun: true,
      requestKey: "same-rule",
    };
    const [a, b] = await Promise.all([
      owner.automation.create(input),
      owner.automation.create(input),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.webhookSecret).toBe(b.webhookSecret);
    const post = (secret: string) =>
      fetch(origin + a.webhookPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ eventId: "crm-1" }),
      });
    expect((await post("invalid")).status).toBe(401);
    const results = await Promise.all([
      post(a.webhookSecret!),
      post(a.webhookSecret!),
    ]);
    expect(results.every(r => r.status === 202)).toBe(true);
    await Promise.all([tickAutomations(), tickAutomations()]);
    const events = await owner.automation.events();
    expect(events.filter(e => e.ruleId === a.id)).toHaveLength(1);
    expect(events.find(e => e.ruleId === a.id)?.status).toBe("enqueued");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM campaign_snapshots WHERE request_key LIKE $1",
          ["automation:%"]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it("scheduled rule persists its due event and advances once across schedulers", async () => {
    const list = await audience();
    const rule = await owner.automation.create({
      name: "Schedule",
      transport: "bot",
      listId: list.id,
      message: "Scheduled",
      parseMode: "None",
      trigger: "schedule",
      intervalMinutes: 5,
      approved: true,
      isDryRun: true,
      requestKey: "schedule-rule",
    });
    await pool.query(
      "UPDATE automation_rules SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [rule.id]
    );
    await Promise.all([tickAutomations(), tickAutomations()]);
    const rows = await pool.query(
      "SELECT * FROM automation_events WHERE rule_id=$1",
      [rule.id]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe("enqueued");
  });
});
