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
import { getAudienceStatus } from "./audienceStatus";
import { closePool, databasePoolConfig, getPool } from "./connection";
import { createRecipientList, upsertMtprotoSession } from "./db";

// Opt-in test database only. Every fixture and migration uses a random schema;
// neither DATABASE_URL nor the application's active schema is a test target.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("read-only audience preflight on PostgreSQL", () => {
  const schema = `audience_status_test_${randomUUID().replaceAll("-", "")}`;
  const ownerId = 73001;
  let admin: Pool, pool: Pool, isolatedUrl: URL;

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
    isolatedUrl = new URL(url!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    pool = getPool();
    await pool.query(
      (
        await readFile(
          new URL("../drizzle/0000_massive_chamber.sql", import.meta.url),
          "utf8"
        )
      ).replaceAll('"public".', `"${schema}".`)
    );
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
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE contact_permissions,recipient_lists,mtproto_sessions,audit_events RESTART IDENTITY CASCADE"
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

  const list = (values: string[], userId = ownerId) =>
    createRecipientList({
      userId,
      name: "Synthetic local audience",
      chatIds: JSON.stringify(values),
      // The report must count canonical members rather than trust this cache.
      totalCount: 999,
      fileType: "json",
    });

  async function permission(
    recipient: string,
    allowed: boolean,
    source: string,
    options: {
      ownerId?: number;
      kind?: "bot" | "mtproto";
      suppressed?: boolean;
    } = {}
  ) {
    await pool.query(
      `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at)
       VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END)`,
      [
        options.ownerId ?? ownerId,
        options.kind ?? "mtproto",
        recipient,
        allowed,
        source,
        options.suppressed ?? false,
      ]
    );
  }

  it("partitions canonical members into eligible, opted-out and unconfirmed groups without returning identities", async () => {
    const selected = await list([
      "101",
      "chat:101",
      "@Example_User",
      "username:example_user",
      "+998901234567",
      "phone:+998901234567",
      "202",
      "303",
      "404",
    ]);
    await permission("chat:101", true, "explicit:consent");
    await permission("phone:+998901234567", true, "explicit:consent");
    await permission("username:example_user", false, "sender:identity_changed");
    await permission("chat:202", false, "explicit:optout", {
      suppressed: true,
    });
    await permission("chat:303", false, "pending:consent");
    // chat:404 has no permission row at all.

    const status = await getAudienceStatus(ownerId, "mtproto", selected.id);
    expect(status).toEqual({
      listId: selected.id,
      total: 6,
      allowed: 2,
      needsConfirmation: 3,
      identityChanged: 1,
      optedOut: 1,
      unsupported: 0,
    });
    expect(JSON.stringify(status)).not.toContain("998901234567");
    expect(JSON.stringify(status)).not.toContain("example_user");
  });

  it("scopes permissions to the selected list, owner and transport and hides foreign lists", async () => {
    const selected = await list(["101", "202", "303", "404"]);
    const foreign = await list(["999"], ownerId + 1);
    await permission("chat:101", true, "foreign:consent", {
      ownerId: ownerId + 1,
    });
    await permission("chat:202", true, "other:transport", { kind: "bot" });
    await permission("chat:303", true, "explicit:consent");
    await permission("chat:999", true, "outside:selected_list");

    expect(await getAudienceStatus(ownerId, "mtproto", selected.id)).toEqual({
      listId: selected.id,
      total: 4,
      allowed: 1,
      needsConfirmation: 3,
      identityChanged: 0,
      optedOut: 0,
      unsupported: 0,
    });
    await expect(
      getAudienceStatus(ownerId, "mtproto", foreign.id)
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getAudienceStatus(ownerId, "mtproto", 2147483647)
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("counts Bot API phone members only as unsupported even when permission or suppression exists", async () => {
    const selected = await list([
      "+998901234567",
      "phone:+998901234567",
      "+998901234568",
      "101",
    ]);
    await permission("phone:+998901234567", true, "explicit:consent", {
      kind: "bot",
    });
    await permission("phone:+998901234568", false, "explicit:optout", {
      kind: "bot",
      suppressed: true,
    });
    await permission("chat:101", true, "explicit:consent", { kind: "bot" });

    expect(await getAudienceStatus(ownerId, "bot", selected.id)).toEqual({
      listId: selected.id,
      total: 3,
      allowed: 1,
      needsConfirmation: 0,
      identityChanged: 0,
      optedOut: 0,
      unsupported: 2,
    });
    expect(
      await getAudienceStatus(ownerId, "mtproto", selected.id)
    ).toMatchObject({
      total: 3,
      allowed: 0,
      needsConfirmation: 3,
      unsupported: 0,
    });
  });

  it("explains 229 imported phones after first sender connection and never regrants during repeated read-only queries", async () => {
    const phones = Array.from(
      { length: 229 },
      (_, index) => `+99890${1000000 + index}`
    );
    const selected = await list(phones);
    await pool.query(
      `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source)
       SELECT $1,'mtproto',recipient,true,'import:explicit_confirmation'
       FROM unnest($2::text[]) AS member(recipient)`,
      [ownerId, phones.map(phone => `phone:${phone}`)]
    );
    expect(
      await getAudienceStatus(ownerId, "mtproto", selected.id)
    ).toMatchObject({
      total: 229,
      allowed: 229,
      needsConfirmation: 0,
    });
    // Real local identity invalidation, with no credentials or Telegram request.
    await upsertMtprotoSession(ownerId, {
      telegramId: "73001",
      isActive: true,
    });
    const before = (
      await pool.query("SELECT * FROM contact_permissions ORDER BY recipient")
    ).rows;

    // PostgreSQL enforces read-only mode for every connection the function can
    // acquire, so an accidental INSERT/UPDATE elsewhere also fails this test.
    await closePool();
    const readOnlyUrl = new URL(isolatedUrl);
    readOnlyUrl.searchParams.set(
      "options",
      `-c search_path=${schema} -c default_transaction_read_only=on`
    );
    vi.stubEnv("DATABASE_URL", readOnlyUrl.toString());
    pool = getPool();
    try {
      expect(
        (await pool.query("SHOW transaction_read_only")).rows[0]
          .transaction_read_only
      ).toBe("on");
      const expected = {
        listId: selected.id,
        total: 229,
        allowed: 0,
        needsConfirmation: 229,
        identityChanged: 229,
        optedOut: 0,
        unsupported: 0,
      };
      expect(await getAudienceStatus(ownerId, "mtproto", selected.id)).toEqual(
        expected
      );
      expect(await getAudienceStatus(ownerId, "mtproto", selected.id)).toEqual(
        expected
      );
      expect(
        (
          await pool.query(
            "SELECT * FROM contact_permissions ORDER BY recipient"
          )
        ).rows
      ).toEqual(before);
    } finally {
      await closePool();
      vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
      pool = getPool();
    }
  });

  it("returns zero for an empty list regardless of unrelated permission rows", async () => {
    const selected = await list([]);
    await permission("chat:101", true, "outside:selected_list");
    expect(await getAudienceStatus(ownerId, "mtproto", selected.id)).toEqual({
      listId: selected.id,
      total: 0,
      allowed: 0,
      needsConfirmation: 0,
      identityChanged: 0,
      optedOut: 0,
      unsupported: 0,
    });
  });

  it("fails closed on malformed local members without including their values in errors", async () => {
    const selected = await list(["private-invalid-member"]);
    await expect(
      getAudienceStatus(ownerId, "mtproto", selected.id)
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Список получателей требует проверки формата",
    });
  });
});
