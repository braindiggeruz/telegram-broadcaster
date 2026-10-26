import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import {
  audienceSourceRouter,
  applyAudienceSourceEvent,
  registerAudienceSourceWebhook,
} from "./audienceSource";
import { closePool, databasePoolConfig, getPool } from "./connection";
import { createRecipientList, getRecipientList } from "./db";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("approved CRM audience source on PostgreSQL", () => {
  const schema = `audience_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, server: Server, baseUrl: string;
  const consentAt = "2026-01-01T10:00:00Z";
  const owner = 71;
  const caller = (id = owner) =>
    audienceSourceRouter.createCaller({
      user: {
        id,
        openId: `owner-${id}`,
        name: "Owner",
        role: "admin",
        email: null,
        loginMethod: "password",
        createdAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: { headers: { origin: "http://127.0.0.1:3131" } } as any,
      res: {} as any,
    });

  beforeAll(async () => {
    admin = new Pool({
      ...databasePoolConfig({
        ...process.env,
        DATABASE_URL: url,
        DATABASE_SSL: "disable",
      }),
      max: 2,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = new URL(url!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 23).toString("base64"));
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3131");
    pool = getPool();
    const base = (
      await readFile(
        new URL("../drizzle/0000_massive_chamber.sql", import.meta.url),
        "utf8"
      )
    ).replaceAll('"public".', `"${schema}".`);
    await pool.query(base);
    for (const migration of [
      "002-security.sql",
      "003-delivery.sql",
      "004-automation.sql",
      "009-audience-sources.sql",
    ])
      await pool.query(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8"
        )
      );
    const app = express();
    app.use(express.json({ limit: "3mb" }));
    registerAudienceSourceWebhook(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE audience_source_members,audience_source_events,audience_sources,contact_permissions,recipient_lists,campaign_snapshots,audit_events RESTART IDENTITY CASCADE"
    );
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  async function prepare(
    transport: "bot" | "mtproto" = "bot",
    values: string[] = ["101"]
  ) {
    const list = await createRecipientList({
      userId: owner,
      name: "CRM audience",
      chatIds: JSON.stringify(values),
      totalCount: values.length,
      fileType: "json",
    });
    const source = await caller().create({
      listId: list.id,
      transport,
      name: "CRM approved source",
      approved: true,
      requestKey: randomUUID(),
    });
    return { list, source };
  }
  const event = (eventId: string, value = "202", subscribed = true) => ({
    eventId,
    recipients: [{ value, subscribed, ...(subscribed ? { consentAt } : {}) }],
  });

  it("creates an idempotent capability with encrypted recovery, safe metadata and owner binding", async () => {
    const list = await createRecipientList({
      userId: owner,
      name: "CRM",
      chatIds: "[]",
      totalCount: 0,
      fileType: "json",
    });
    const input = {
      listId: list.id,
      transport: "bot" as const,
      name: "CRM",
      approved: true as const,
      requestKey: "create-001",
    };
    const [first, second] = await Promise.all([
      caller().create(input),
      caller().create(input),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.secret).toBe(second.secret);
    expect(first.webhookSecret).toBe(first.secret);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM audience_sources"))
        .rows[0].count
    ).toBe(1);
    const stored = (
      await pool.query(
        "SELECT secret_hash,encrypted_secret FROM audience_sources"
      )
    ).rows[0];
    expect(stored.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.encrypted_secret).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored)).not.toContain(first.secret);
    const metadata = await caller().list();
    expect(metadata[0]).toMatchObject({
      listId: list.id,
      active: true,
      transport: "bot",
    });
    expect(JSON.stringify(metadata)).not.toContain(first.secret);
    expect(await caller(72).list()).toEqual([]);
    await expect(
      caller(72).create({ ...input, requestKey: "foreign" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller().create({ ...input, name: "Changed" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(72).revoke({ id: first.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("normalizes typed recipients, records dated consent, and grants only the approved transport", async () => {
    const { list, source } = await prepare();
    const result = await applyAudienceSourceEvent(source.id, source.secret, {
      eventId: "sync-001",
      recipients: [
        { value: "@Example_User", subscribed: true, consentAt },
        { value: "chat:-1001234567890", subscribed: true, consentAt },
      ],
    });
    expect(result).toMatchObject({
      applied: true,
      duplicate: false,
      totalCount: 3,
      subscribed: 2,
    });
    expect(
      JSON.parse((await getRecipientList(list.id, owner))!.chatIds)
    ).toEqual(
      expect.arrayContaining(["101", "@example_user", "-1001234567890"])
    );
    const rows = (
      await pool.query(
        "SELECT kind,recipient,allowed,source FROM contact_permissions ORDER BY recipient"
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        row =>
          row.kind === "bot" &&
          row.allowed &&
          row.source.includes("CRM approved source")
      )
    ).toBe(true);
    expect(rows.map(row => row.recipient)).toEqual([
      "chat:-1001234567890",
      "username:example_user",
    ]);
    const proof = (
      await pool.query(
        "SELECT consent_at,last_event_key FROM audience_source_members LIMIT 1"
      )
    ).rows[0];
    expect(proof.consent_at.toISOString()).toBe(
      new Date(consentAt).toISOString()
    );
    expect(proof.last_event_key).toBe("sync-001");
  });

  it("keeps opt-outs sticky across later syncs and leaves existing campaign snapshots unchanged", async () => {
    const { list, source } = await prepare();
    await pool.query(
      "INSERT INTO campaign_snapshots(owner_id,kind,broadcast_id,request_key,recipients) VALUES($1,'bot',1,'snapshot',$2)",
      [owner, JSON.stringify(["101", "202"])]
    );
    await applyAudienceSourceEvent(
      source.id,
      source.secret,
      event("subscribe")
    );
    await applyAudienceSourceEvent(
      source.id,
      source.secret,
      event("unsubscribe", "202", false)
    );
    const retry = await applyAudienceSourceEvent(
      source.id,
      source.secret,
      event("resync")
    );
    expect(retry).toMatchObject({
      subscribed: 0,
      suppressed: 1,
      totalCount: 1,
    });
    expect(
      JSON.parse((await getRecipientList(list.id, owner))!.chatIds)
    ).toEqual(["101"]);
    const permission = (
      await pool.query(
        "SELECT allowed,suppressed_at FROM contact_permissions WHERE recipient='chat:202'"
      )
    ).rows[0];
    expect(permission.allowed).toBe(false);
    expect(permission.suppressed_at).toBeInstanceOf(Date);
    expect(
      (await pool.query("SELECT recipients FROM campaign_snapshots")).rows[0]
        .recipients
    ).toEqual(["101", "202"]);
  });

  it("deduplicates concurrent events and rejects changed payload reuse atomically", async () => {
    const { list, source } = await prepare();
    const results = await Promise.all([
      applyAudienceSourceEvent(source.id, source.secret, event("same-event")),
      applyAudienceSourceEvent(source.id, source.secret, event("same-event")),
    ]);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audience_source_events"
        )
      ).rows[0].count
    ).toBe(1);
    await expect(
      applyAudienceSourceEvent(
        source.id,
        source.secret,
        event("same-event", "303")
      )
    ).rejects.toMatchObject({ status: 409, code: "EVENT_ID_CONFLICT" });
    expect(
      JSON.parse((await getRecipientList(list.id, owner))!.chatIds)
    ).toEqual(["101", "202"]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM contact_permissions WHERE recipient='chat:303'"
        )
      ).rows[0].count
    ).toBe(0);
  });

  it("rejects missing/future consent, ambiguous values, duplicate aliases and invalid batch fields", async () => {
    const { source } = await prepare();
    const bad = [
      { eventId: "missing", recipients: [{ value: "202", subscribed: true }] },
      {
        eventId: "future",
        recipients: [
          {
            value: "202",
            subscribed: true,
            consentAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      },
      {
        eventId: "invalid",
        recipients: [{ value: "order 123456789012", subscribed: false }],
      },
      {
        eventId: "aliases",
        recipients: [
          { value: "@Example_User", subscribed: false },
          { value: "username:example_user", subscribed: false },
        ],
      },
      {
        eventId: "extra",
        recipients: [
          { value: "202", subscribed: true, consentAt, approved: true },
        ],
      },
      {
        eventId: "large",
        recipients: Array.from({ length: 10001 }, (_, i) => ({
          value: String(i + 1),
          subscribed: false,
        })),
      },
    ];
    for (const body of bad)
      await expect(
        applyAudienceSourceEvent(source.id, source.secret, body)
      ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audience_source_events"
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM contact_permissions"
        )
      ).rows[0].count
    ).toBe(0);
  });

  it("does not allow phone imports through a Bot API source", async () => {
    const { source } = await prepare();
    await expect(
      applyAudienceSourceEvent(
        source.id,
        source.secret,
        event("phone", "+998900000000")
      )
    ).rejects.toMatchObject({ status: 400, code: "BOT_PHONE_NOT_ADDRESSABLE" });
    const personal = await prepare("mtproto", []);
    await expect(
      applyAudienceSourceEvent(
        personal.source.id,
        personal.source.secret,
        event("phone", "+998900000000")
      )
    ).resolves.toMatchObject({ subscribed: 1 });
    expect(
      (await pool.query("SELECT kind,recipient FROM contact_permissions")).rows
    ).toEqual([{ kind: "mtproto", recipient: "phone:+998900000000" }]);
  });

  it("requires the bearer capability over HTTP and stops immediately after source revocation", async () => {
    const { source } = await prepare();
    const post = (secret?: string) =>
      fetch(`${baseUrl}${source.webhookPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(event("http-event")),
      });
    expect((await post()).status).toBe(401);
    expect((await post("x".repeat(43))).status).toBe(401);
    const accepted = await post(source.secret);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      applied: true,
      duplicate: false,
    });
    await caller().revoke({ id: source.id });
    expect((await caller().list())[0].active).toBe(false);
    const rejected = await post(source.secret);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "SOURCE_REVOKED" });
  });

  it("revalidates list ownership on every sync and performs no partial permission grant", async () => {
    const { list, source } = await prepare();
    await pool.query('UPDATE recipient_lists SET "userId"=72 WHERE id=$1', [
      list.id,
    ]);
    await expect(
      applyAudienceSourceEvent(
        source.id,
        source.secret,
        event("ownership-changed")
      )
    ).rejects.toMatchObject({ status: 409, code: "SOURCE_LIST_UNAVAILABLE" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM contact_permissions"
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audience_source_events"
        )
      ).rows[0].count
    ).toBe(0);
  });
});
