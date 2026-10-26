import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, databasePoolConfig, getPool } from "./connection";
import * as db from "./db";
import { createCampaign, launchCampaign } from "./campaigns";
import type { SenderKind } from "./delivery/types";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("absolute timestamps on a non-UTC PostgreSQL session", () => {
  const schema = `timestamps_test_${randomUUID().replaceAll("-", "")}`;
  const ownerId = 86001;
  const legacyIds: Partial<Record<SenderKind, number>> = {};
  let admin: Pool, pool: Pool;

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
    isolated.searchParams.set(
      "options",
      `-c search_path=${schema} -c TimeZone=Asia/Karachi`
    );
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("DATABASE_SSL", "disable");
    vi.stubEnv("LIVE_SEND_ENABLED", "false");
    pool = getPool();
    expect((await pool.query("SHOW TimeZone")).rows[0].TimeZone).toBe(
      "Asia/Karachi"
    );
    await pool.query(
      (await readFile("drizzle/0000_massive_chamber.sql", "utf8")).replaceAll(
        '"public".',
        `"${schema}".`
      )
    );
    const originalColumn = await pool.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='broadcasts' AND column_name='createdAt'",
      [schema]
    );
    expect(originalColumn.rows[0].data_type).toBe("timestamp without time zone");

    // These values reproduce the old database's local wall-time storage.
    // Insert before any migration so a fresh-schema test cannot hide data loss.
    for (const kind of ["bot", "mtproto"] as const) {
      const table = kind === "bot" ? "broadcasts" : "mtproto_broadcasts";
      const result = await pool.query(
        `INSERT INTO ${table} ("userId",name,message,"isDryRun","createdAt","updatedAt","startedAt")
         VALUES($1,'Legacy timezone fixture','Synthetic message',true,
           '2026-10-26 18:00:00','2026-10-26 18:30:00','2026-10-26 18:05:00') RETURNING id`,
        [ownerId]
      );
      legacyIds[kind] = result.rows[0].id;
    }
    for (const file of (await readdir("migrations"))
      .filter(name => name.endsWith(".sql"))
      .sort()) {
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    }
  }, 30000);

  afterAll(async () => {
    await closePool();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  for (const kind of ["bot", "mtproto"] as const) {
    const getBroadcast =
      kind === "bot" ? db.getBroadcast : db.getMtprotoBroadcast;

    it(`${kind}: migrates legacy local timestamps to their original UTC instants`, async () => {
      const result = await getBroadcast(legacyIds[kind]!, ownerId);
      expect(result.createdAt.toISOString()).toBe("2026-10-26T13:00:00.000Z");
      expect(result.updatedAt.toISOString()).toBe("2026-10-26T13:30:00.000Z");
      expect(result.startedAt?.toISOString()).toBe("2026-10-26T13:05:00.000Z");
      expect(result.completedAt).toBeNull();
    });

    it(`${kind}: creates a campaign now and expires it exactly seven days later`, async () => {
      const list = await db.createRecipientList({
        userId: ownerId,
        name: `Synthetic ${kind} timezone list`,
        chatIds: JSON.stringify(["chat:86001001"]),
        totalCount: 1,
        fileType: "json",
      });
      const before = Date.now();
      const created = await createCampaign(ownerId, kind, {
        name: `Synthetic ${kind} timezone campaign`,
        message: "This dry run never dispatches to Telegram",
        parseMode: "None",
        delaySeconds: 3,
        isDryRun: true,
        recipientListId: list.id,
      });
      const after = Date.now();
      const stored = await getBroadcast(created.id, ownerId);
      // PostgreSQL and JS clocks are on the same local test host; tolerate 1s.
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(stored.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
      expect(stored.createdAt.getTime()).toBe(created.createdAt.getTime());

      await launchCampaign(ownerId, kind, created.id);
      const queue = await pool.query(
        "SELECT expires_at,is_dry_run FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3",
        [ownerId, kind, created.id]
      );
      expect(queue.rowCount).toBe(1);
      expect(queue.rows[0].is_dry_run).toBe(true);
      expect(queue.rows[0].expires_at.getTime()).toBe(
        stored.createdAt.getTime() + 7 * 86400000
      );
      expect(queue.rows[0].expires_at.getTime()).toBeGreaterThanOrEqual(
        before + 7 * 86400000 - 1000
      );
      expect(queue.rows[0].expires_at.getTime()).toBeLessThanOrEqual(
        after + 7 * 86400000 + 1000
      );
    });
  }
});
