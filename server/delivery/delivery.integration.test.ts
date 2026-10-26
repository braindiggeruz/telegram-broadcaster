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
import { DeliveryService } from "./service";
import {
  DeliveryError,
  type EnqueueInput,
  type DeliveryTransport,
} from "./types";
import {
  recordWorkerHeartbeat,
  recordWorkerSuccess,
  runWorkerOnce,
} from "./worker";

// Opt-in isolated integration database. Each suite owns a random schema; no public tables are modified.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("durable delivery on PostgreSQL", () => {
  const schema = `delivery_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let service: DeliveryService;
  const base: EnqueueInput = {
    ownerId: 70001,
    kind: "bot",
    broadcastId: 1,
    message: "Expected message",
    parseMode: null,
    recipients: ["chat:101", "chat:102"],
    delaySeconds: 0,
    isDryRun: false,
  };
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: url,
      max: 10,
      options: `-c search_path=${schema}`,
      application_name: schema,
    });
    pool.on("error", () => {});
    for (const file of [
      "003-delivery.sql",
      "005-delivery-resolutions.sql",
      "006-delivery-identity.sql",
      "011-worker-health.sql",
    ]) {
      await pool.query(
        await readFile(
          new URL(`../../migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    }
    // This queue-only fixture deliberately omits the legacy app tables required by 014.
    // Full media/schema migration coverage lives in photo-campaigns.integration.test.ts.
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
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE delivery_resolutions,delivery_attempts,deliveries,delivery_campaigns,contact_permissions,contact_delivery_controls,sender_controls,delivery_worker_heartbeats RESTART IDENTITY CASCADE"
    );
  });
  async function prepare(input: Partial<EnqueueInput> = {}) {
    const value = { ...base, ...input };
    for (const recipient of value.recipients)
      await service.setContactPermission({
        ownerId: value.ownerId,
        kind: value.kind,
        recipient,
        allowed: true,
        source: "integration-explicit-optin",
      });
    return service.enqueueCampaign(value);
  }
  async function unpace() {
    await pool.query(
      `UPDATE sender_controls SET next_send_at=now()-interval '1 second'`
    );
  }
  const worker = (
    transport: DeliveryTransport,
    extra: Record<string, unknown> = {}
  ) =>
    runWorkerOnce({
      pool,
      transport,
      liveSendEnabled: true,
      contactMinIntervalSeconds: 0,
      ...extra,
    });

  it("reserves a bounded phone-lookup lease and releases only its own lease to normal pacing", async () => {
    await prepare({ kind: "mtproto", recipients: ["phone:+19990000000"] });
    const send = vi.fn(async () => {
      const row = (
        await pool.query(
          "SELECT EXTRACT(EPOCH FROM(next_send_at-now()))::double precision AS seconds FROM sender_controls"
        )
      ).rows[0];
      expect(row.seconds).toBeGreaterThan(20);
      expect(row.seconds).toBeLessThanOrEqual(23.1);
      return { messageId: "synthetic-phone-message" };
    });
    await worker({ send }, { dispatchTimeoutMs: 20_000 });
    const row = (
      await pool.query(
        "SELECT EXTRACT(EPOCH FROM(next_send_at-now()))::double precision AS seconds FROM sender_controls"
      )
    ).rows[0];
    expect(row.seconds).toBeGreaterThan(0);
    expect(row.seconds).toBeLessThanOrEqual(3.1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "mtproto", 1)).toMatchObject(
      { accepted: 1, status: "completed" }
    );
  });

  it("does not shorten a pacing deadline written after the phone-lookup reservation", async () => {
    await prepare({ kind: "mtproto", recipients: ["phone:+19990000000"] });
    const send = vi.fn(async () => {
      await pool.query(
        "UPDATE sender_controls SET next_send_at=now()+interval '1 hour'"
      );
      return { messageId: "synthetic-phone-message" };
    });
    await worker({ send }, { dispatchTimeoutMs: 20_000 });
    const row = (
      await pool.query(
        "SELECT EXTRACT(EPOCH FROM(next_send_at-now()))::double precision AS seconds FROM sender_controls"
      )
    ).rows[0];
    expect(row.seconds).toBeGreaterThan(3590);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains the committed phone-lookup lease when outcome persistence fails and blocks another recipient after recovery", async () => {
    await prepare({
      kind: "mtproto",
      recipients: ["phone:+19990000000", "phone:+19990000001"],
    });
    await pool.query(`CREATE FUNCTION reject_phone_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic-result-persistence-failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_phone_result BEFORE UPDATE OF state ON deliveries
      FOR EACH ROW WHEN (NEW.state='accepted') EXECUTE FUNCTION reject_phone_result()`);
    const send = vi.fn(async () => ({ messageId: "synthetic-phone-message" }));
    try {
      await expect(
        worker({ send }, { dispatchTimeoutMs: 20_000 })
      ).rejects.toThrow("synthetic-result-persistence-failure");
      const row = (
        await pool.query(
          "SELECT EXTRACT(EPOCH FROM(next_send_at-now()))::double precision AS seconds FROM sender_controls"
        )
      ).rows[0];
      expect(row.seconds).toBeGreaterThan(3);
      expect(row.seconds).toBeLessThanOrEqual(23.1);
      expect(
        await service.getProgress(base.ownerId, "mtproto", 1)
      ).toMatchObject({ inflight: 1, pending: 1, accepted: 0 });
      expect(await worker({ send }, { dispatchTimeoutMs: 20_000 })).toEqual({
        worked: false,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await service.getProgress(base.ownerId, "mtproto", 1)
      ).toMatchObject({ unknown: 1, pending: 1, accepted: 0 });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS reject_phone_result ON deliveries"
      );
      await pool.query("DROP FUNCTION IF EXISTS reject_phone_result()");
    }
  });

  it("atomically deduplicates concurrent launch and keeps the original immutable snapshot", async () => {
    const results = await Promise.all([prepare(), prepare()]);
    expect(results.filter(x => x.enqueued)).toHaveLength(1);
    expect(results[0].campaignId).toBe(results[1].campaignId);
    expect((await pool.query("SELECT * FROM deliveries")).rowCount).toBe(2);
    await expect(
      service.enqueueCampaign({ ...base, message: "Changed after approval" })
    ).rejects.toThrow("SNAPSHOT_CONFLICT");
    expect(await service.getProgress(999, "bot", 1)).toBeNull();
  });

  it("pins the approved sender credential in the immutable snapshot and transport request", async () => {
    const fingerprint = "a".repeat(64);
    await prepare({ recipients: ["101"], senderFingerprint: fingerprint });
    await expect(
      service.enqueueCampaign({
        ...base,
        recipients: ["101"],
        senderFingerprint: "b".repeat(64),
      })
    ).rejects.toThrow("SNAPSHOT_CONFLICT");
    const send = vi.fn(async () => ({ messageId: "one" }));
    await worker({ send });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ senderFingerprint: fingerprint })
    );
  });

  it("serializes two workers across the same sender and acknowledges cancel only after dispatch", async () => {
    await prepare();
    let complete!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const blocking = new Promise<void>(resolve => {
      complete = resolve;
    });
    const send = vi.fn(async () => {
      started();
      await blocking;
      return { messageId: "42" };
    });
    const first = worker({ send });
    await entered;
    expect(await worker({ send })).toEqual({ worked: false });
    const cancel = await service.cancelCampaign(base.ownerId, "bot", 1);
    expect(cancel).toEqual({ status: "stopping", acknowledged: false });
    expect((await service.getProgress(base.ownerId, "bot", 1))?.running).toBe(
      true
    );
    complete();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      status: "stopped",
      accepted: 1,
      cancelled: 1,
      running: false,
    });
    await unpace();
    await worker({ send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never calls Telegram for dry-run or when live sending is disabled", async () => {
    await prepare({ recipients: ["101"] });
    const send = vi.fn(async () => ({ messageId: "never" }));
    expect(await worker({ send }, { liveSendEnabled: false })).toEqual({
      worked: false,
    });
    await prepare({ broadcastId: 2, isDryRun: true, recipients: ["102"] });
    await worker({ send }, { liveSendEnabled: false });
    expect(send).not.toHaveBeenCalled();
    expect(await service.getProgress(base.ownerId, "bot", 2)).toMatchObject({
      status: "completed",
      dryRun: 1,
      accepted: 0,
    });
  });

  it("checks consent at dispatch and keeps opt-out sticky across reimport, including dry-run", async () => {
    await prepare({ isDryRun: true });
    await service.setContactPermission({
      ownerId: base.ownerId,
      kind: "bot",
      recipient: "101",
      allowed: false,
      source: "user-stop",
    });
    const reimport = await service.setContactPermission({
      ownerId: base.ownerId,
      kind: "bot",
      recipient: "101",
      allowed: true,
      source: "csv-reimport",
    });
    expect(reimport.allowed).toBe(false);
    const send = vi.fn(async () => ({}));
    await worker({ send });
    await worker({ send });
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      suppressed: 1,
      dryRun: 1,
      accepted: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("retains sender-wide FLOOD_WAIT across worker restarts and manual resume cannot shorten it", async () => {
    await prepare();
    const send = vi.fn(async () => {
      throw new DeliveryError("cooldown", "FLOOD_WAIT_120", 120);
    });
    await worker({ send });
    await unpace();
    await service.resumeSender(base.ownerId, "bot");
    expect((await service.getSenderStatus(base.ownerId, "bot")).state).toBe(
      "COOLDOWN"
    );
    const nextSend = vi.fn(async () => ({}));
    expect(await worker({ send: nextSend })).toEqual({ worked: false });
    expect(nextSend).not.toHaveBeenCalled();
    const control = await pool.query(
      "SELECT cooldown_until FROM sender_controls"
    );
    expect(new Date(control.rows[0].cooldown_until).getTime()).toBeGreaterThan(
      Date.now() + 100000
    );
  });

  it("limits slowmode to its recipient and allows another chat to proceed", async () => {
    await prepare();
    const send = vi.fn(async request => {
      if (request.recipient === "chat:101")
        throw new DeliveryError("slowmode", "SLOWMODE_WAIT_120", 120);
      return { messageId: "other-chat" };
    });
    await worker({ send });
    await unpace();
    await worker({ send });
    expect((await service.getSenderStatus(base.ownerId, "bot")).state).toBe(
      "READY"
    );
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      accepted: 1,
      pending: 1,
    });
  });

  it("distinguishes a deleted recipient from restriction of the sender", async () => {
    await prepare();
    const send = vi.fn(async () => {
      throw new DeliveryError("recipient", "INPUT_USER_DEACTIVATED");
    });
    await worker({ send });
    expect((await service.getSenderStatus(base.ownerId, "bot")).state).toBe(
      "READY"
    );
    await unpace();
    await worker({
      send: async () => {
        throw new DeliveryError("restricted", "PEER_FLOOD");
      },
    });
    expect((await service.getSenderStatus(base.ownerId, "bot")).state).toBe(
      "REVIEW_REQUIRED"
    );
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      failed: 1,
      pending: 1,
    });
  });

  it("never retries ambiguous external outcomes and logs them distinctly from accepted", async () => {
    await prepare({ recipients: ["101"] });
    const send = vi.fn(async () => {
      throw new Error("network lost after external acceptance");
    });
    await worker({ send });
    await unpace();
    await worker({ send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      status: "review_required",
      unknown: 1,
      accepted: 0,
    });
    const logs = await service.getDeliveryLogs(base.ownerId, "bot", 1);
    expect(logs.items[0]).toMatchObject({
      status: "unknown",
      success: false,
      errorMessage: "DELIVERY_RESULT_UNKNOWN",
    });
  });

  it("recovers a worker crash after possible external acceptance as unknown, preserving random_id", async () => {
    await prepare({ recipients: ["101"] });
    const before = (await pool.query("SELECT id,random_id FROM deliveries"))
      .rows[0];
    const attempt = randomUUID();
    await pool.query(
      `UPDATE deliveries SET state='inflight',attempt_id=$1 WHERE id=$2`,
      [attempt, before.id]
    );
    await pool.query(
      `INSERT INTO delivery_attempts(id,delivery_id,state) VALUES($1,$2,'inflight')`,
      [attempt, before.id]
    );
    const send = vi.fn(async () => ({}));
    await worker({ send });
    expect(send).not.toHaveBeenCalled();
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      status: "review_required",
      unknown: 1,
    });
    expect(
      (await pool.query("SELECT random_id FROM deliveries")).rows[0].random_id
    ).toBe(before.random_id);
  });

  it("recovers abandoned inflight even when credential replacement already placed its campaign in review", async () => {
    await prepare({ recipients: ["101"] });
    const delivery = (await pool.query("SELECT id,campaign_id FROM deliveries"))
      .rows[0];
    const attempt = randomUUID();
    await pool.query(
      "UPDATE deliveries SET state='inflight',attempt_id=$1 WHERE id=$2",
      [attempt, delivery.id]
    );
    await pool.query(
      "INSERT INTO delivery_attempts(id,delivery_id,state) VALUES($1,$2,'inflight')",
      [attempt, delivery.id]
    );
    await pool.query(
      "UPDATE delivery_campaigns SET status='review_required' WHERE id=$1",
      [delivery.campaign_id]
    );
    const send = vi.fn(async () => ({ messageId: "must-never-send" }));
    await worker({ send });
    expect(send).not.toHaveBeenCalled();
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      status: "review_required",
      unknown: 1,
      inflight: 0,
    });
    expect(
      (
        await pool.query("SELECT state FROM delivery_attempts WHERE id=$1", [
          attempt,
        ])
      ).rows[0].state
    ).toBe("unknown");
    expect(
      await service.resolveUnknown({
        ownerId: base.ownerId,
        kind: "bot",
        broadcastId: 1,
        deliveryIds: [String(delivery.id)],
        resolution: "cancelled",
        evidence: "Owner closed recovered uncertain delivery without retry",
      })
    ).toMatchObject({ resolved: 1 });
  });

  it("recovers an actual post-acceptance persistence error without a second send", async () => {
    await prepare({ recipients: ["101"] });
    const connect = pool.connect.bind(pool);
    let faultInjected = false;
    const faultyPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await connect();
        const original = client.query.bind(client);
        client.query = ((...args: unknown[]) => {
          const sql = args[0];
          if (
            !faultInjected &&
            typeof sql === "string" &&
            sql.includes("SET state=$3,last_error=$4,message_id=$5") &&
            (args[1] as unknown[])?.[2] === "accepted"
          ) {
            faultInjected = true;
            return Promise.reject(
              new Error("simulated durable log write failure")
            );
          }
          return (original as (...values: unknown[]) => unknown)(...args);
        }) as typeof client.query;
        return client;
      },
    } as unknown as Pool;
    const send = vi.fn(async () => ({ messageId: "accepted-before-db-fault" }));
    await expect(worker({ send }, { pool: faultyPool })).rejects.toThrow(
      "simulated durable log write failure"
    );
    await worker({ send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      unknown: 1,
      accepted: 0,
    });
  });

  it("aborts active transport on loss of its database lock and never redelivers the abandoned claim", async () => {
    await prepare({ recipients: ["101"] });
    let pid = 0;
    const observedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        return client;
      },
    } as unknown as Pool;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const send = vi.fn(async request => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true }
        )
      );
      return { messageId: "unreachable" };
    });
    const pending = worker({ send }, { pool: observedPool });
    const rejection = expect(pending).rejects.toThrow();
    await started;
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await rejection;
    await worker({ send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      unknown: 1,
      status: "review_required",
    });
  });

  it("uses frequency limits across campaigns and expires messages instead of sending stale content", async () => {
    await prepare({ recipients: ["101"] });
    await prepare({
      broadcastId: 2,
      recipients: ["101"],
      expiresAt: new Date(Date.now() + 60000),
    });
    const send = vi.fn(async () => ({ messageId: "one" }));
    await worker({ send }, { contactMinIntervalSeconds: 3600 });
    await unpace();
    await worker({ send }, { contactMinIntervalSeconds: 3600 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await service.getProgress(base.ownerId, "bot", 2)).toMatchObject({
      pending: 1,
      accepted: 0,
    });
    await pool.query(
      `UPDATE delivery_campaigns SET expires_at=now()-interval '1 second' WHERE broadcast_id=2`
    );
    await worker({ send });
    expect(await service.getProgress(base.ownerId, "bot", 2)).toMatchObject({
      status: "expired",
      expired: 1,
    });
  });

  it("explicit resume touches only cancelled work, never accepted or unknown deliveries", async () => {
    await prepare();
    await worker({ send: async () => ({ messageId: "first" }) });
    await service.cancelCampaign(base.ownerId, "bot", 1);
    expect(await service.resumeCampaign(base.ownerId, "bot", 1)).toEqual({
      resumed: 1,
    });
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      accepted: 1,
      pending: 1,
    });
  });

  it("resolves unknown outcomes only with explicit evidence and an immutable audit, without retry", async () => {
    await prepare({ recipients: ["101"] });
    const send = vi.fn(async () => {
      throw new Error("ambiguous result");
    });
    await worker({ send });
    const id = (await service.getDeliveryLogs(base.ownerId, "bot", 1)).items[0]
      .id;
    const input = {
      ownerId: base.ownerId,
      kind: "bot" as const,
      broadcastId: 1,
      deliveryIds: [id],
      resolution: "accepted" as const,
      evidence: "Verified message in recipient conversation on 2026-10-26",
    };
    await expect(
      service.resolveUnknown({ ...input, evidence: "ok" })
    ).rejects.toThrow("EVIDENCE_REQUIRED");
    await expect(
      service.resolveUnknown({ ...input, ownerId: 70002 })
    ).rejects.toThrow("CAMPAIGN_NOT_FOUND");
    await expect(
      service.resolveUnknown({ ...input, deliveryIds: [id, "999999"] })
    ).rejects.toThrow("ONLY_UNKNOWN");
    expect(
      (await pool.query("SELECT * FROM delivery_resolutions")).rowCount
    ).toBe(0);
    expect(await service.resolveUnknown(input)).toEqual({
      resolved: 1,
      resolution: "accepted",
    });
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      accepted: 1,
      unknown: 0,
      status: "completed",
    });
    expect(
      (await pool.query("SELECT state FROM delivery_attempts")).rows[0].state
    ).toBe("unknown");
    expect(
      (await pool.query("SELECT evidence FROM delivery_resolutions")).rows[0]
        .evidence
    ).toBe(input.evidence);
    await expect(service.resolveUnknown(input)).rejects.toThrow("ONLY_UNKNOWN");
    await worker({ send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown closed without retry excluded when a cancelled campaign resumes", async () => {
    await prepare({ recipients: ["101", "102"] });
    await worker({
      send: async () => {
        throw new Error("ambiguous");
      },
    });
    const logs = await service.getDeliveryLogs(base.ownerId, "bot", 1);
    const unknownId = logs.items.find(item => item.status === "unknown")!.id;
    const pendingId = logs.items.find(item => item.status === "pending")!.id;
    const input = {
      ownerId: base.ownerId,
      kind: "bot" as const,
      broadcastId: 1,
      deliveryIds: [unknownId, pendingId],
      resolution: "cancelled" as const,
      evidence: "Owner closes uncertain message without retry",
    };
    await expect(service.resolveUnknown(input)).rejects.toThrow("ONLY_UNKNOWN");
    expect(
      (await pool.query("SELECT * FROM delivery_resolutions")).rowCount
    ).toBe(0);
    await service.cancelCampaign(base.ownerId, "bot", 1);
    await service.resolveUnknown({ ...input, deliveryIds: [unknownId] });
    expect(await service.resumeCampaign(base.ownerId, "bot", 1)).toEqual({
      resumed: 1,
    });
    expect(await service.getProgress(base.ownerId, "bot", 1)).toMatchObject({
      pending: 1,
      cancelled: 1,
      unknown: 0,
    });
  });

  it("paginates full delivery outcomes without cross-owner access", async () => {
    await prepare({ isDryRun: true, recipients: ["101", "102", "103"] });
    for (let i = 0; i < 3; i++) await worker({ send: async () => ({}) });
    const first = await service.getDeliveryLogs(base.ownerId, "bot", 1, {
      limit: 2,
    });
    const second = await service.getDeliveryLogs(base.ownerId, "bot", 1, {
      limit: 2,
      offset: 2,
    });
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect((await service.getDeliveryLogs(70002, "bot", 1)).items).toEqual([]);
  });

  it("keeps worker loop errors visible through heartbeat updates until an actual successful iteration", async () => {
    await recordWorkerHeartbeat(pool, "test-worker", false);
    let status = (await service.getWorkerStatus())[0];
    expect(status).toMatchObject({
      healthy: true,
      last_error: null,
      last_success_at: null,
    });
    await recordWorkerHeartbeat(
      pool,
      "test-worker",
      false,
      "WORKER_TICK_FAILED"
    );
    await recordWorkerHeartbeat(pool, "test-worker", false);
    status = (await service.getWorkerStatus())[0];
    expect(status).toMatchObject({
      healthy: true,
      last_error: "WORKER_TICK_FAILED",
      last_success_at: null,
    });
    await recordWorkerSuccess(pool, "test-worker", false);
    status = (await service.getWorkerStatus())[0];
    expect(status).toMatchObject({
      healthy: true,
      last_error: null,
      last_success_at: expect.any(Date),
    });
    await pool.query(
      "UPDATE delivery_worker_heartbeats SET last_success_at=now()-interval '5 minutes'"
    );
    await recordWorkerHeartbeat(pool, "test-worker", false);
    expect(
      (await service.getWorkerStatus())[0].last_success_at!.getTime()
    ).toBeLessThan(Date.now() - 240000);
  });
});
