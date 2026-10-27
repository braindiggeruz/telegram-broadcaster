import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryService } from "./service";

// CI-only isolated schema. No transport client or real recipient is used.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("campaign queue progress on PostgreSQL", () => {
  const schema = `progress_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let service: DeliveryService;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: url,
      max: 2,
      options: `-c search_path=${schema}`,
    });
    for (const file of ["003-delivery.sql", "006-delivery-identity.sql"])
      await pool.query(
        await readFile(
          new URL(`../../migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    await pool.query(
      "ALTER TABLE delivery_campaigns ADD COLUMN photo_id uuid, ADD COLUMN photo_sha256 text"
    );
    service = new DeliveryService(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("counts confirmed-unsent retries inside pending and suppresses retry timing during diagnostic pause", async () => {
    const recipients = ["chat:101", "chat:102", "chat:103", "chat:104"];
    await service.enqueueCampaign({
      ownerId: 72001,
      kind: "mtproto",
      broadcastId: 7,
      message: "Synthetic progress fixture",
      recipients,
      delaySeconds: 3,
      isDryRun: false,
    });
    const deliveries = (
      await pool.query("SELECT id,recipient FROM deliveries ORDER BY id")
    ).rows;
    for (const [index, state] of [
      [0, "deferred"],
      [1, "rejected"],
      [3, "deferred"],
    ] as const) {
      const attempt = randomUUID();
      await pool.query(
        "INSERT INTO delivery_attempts(id,delivery_id,state) VALUES($1,$2,$3)",
        [attempt, deliveries[index].id, state]
      );
      await pool.query("UPDATE deliveries SET attempt_id=$2 WHERE id=$1", [
        deliveries[index].id,
        attempt,
      ]);
    }
    await pool.query(
      "UPDATE deliveries SET available_at=now()+interval '1 minute',last_error='MTPROTO_RESOLUTION_UNAVAILABLE' WHERE id=$1",
      [deliveries[0].id]
    );
    await pool.query(
      "UPDATE deliveries SET state='failed',last_error='PHONE_NOT_OCCUPIED' WHERE id=$1",
      [deliveries[3].id]
    );
    await pool.query("UPDATE deliveries SET updated_at='2026-01-02T03:04:05Z'");
    await pool.query(
      "UPDATE deliveries SET updated_at='2026-01-02T03:04:06Z' WHERE id=$1",
      [deliveries[0].id]
    );
    await pool.query(
      "UPDATE sender_controls SET state='DISABLED',reason='DIAGNOSTIC_PAUSE'"
    );
    const paused = await service.getProgress(72001, "mtproto", 7);
    expect(paused).toMatchObject({
      total: 4,
      accepted: 0,
      failed: 1,
      pending: 3,
      inflight: 0,
      retryPending: 1,
      unknown: 0,
      nextAttemptAt: null,
      lastActivityAt: new Date("2026-01-02T03:04:06Z"),
      sender: { state: "DISABLED", reason: "DIAGNOSTIC_PAUSE" },
    });
    expect(await service.getProgress(72002, "mtproto", 7)).toBeNull();
    expect(await service.getProgress(72001, "bot", 7)).toBeNull();

    await pool.query(
      "UPDATE sender_controls SET state='READY',reason=NULL,next_send_at=now()+interval '2 minutes'"
    );
    const ready = await service.getProgress(72001, "mtproto", 7);
    expect(ready?.retryPending).toBe(1);
    expect(ready?.nextAttemptAt?.getTime()).toBeGreaterThan(
      Date.now() + 110_000
    );
    await pool.query(
      "UPDATE sender_controls SET state='COOLDOWN',cooldown_until=now()+interval '3 minutes'"
    );
    const cooldown = await service.getProgress(72001, "mtproto", 7);
    expect(cooldown?.nextAttemptAt?.getTime()).toBeGreaterThan(
      Date.now() + 170_000
    );
    expect(cooldown?.accepted).toBe(0);
    await pool.query(
      "UPDATE delivery_campaigns SET expires_at=now()-interval '1 second'"
    );
    const expired = await service.getProgress(72001, "mtproto", 7);
    expect(expired?.nextAttemptAt).toBeNull();
    expect(expired?.pending).toBe(3);
  });
});
