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
import {
  LeadRadarEffects,
  LR_SCHEMA,
  commandDigest,
  effectRandomId,
  type LrCommand,
  type LrConfig,
} from "./leadRadarEffects";
import { DeliveryError, type DeliveryRequest } from "./types";
import { DeliveryService } from "./service";
import { runWorkerOnce } from "./worker";
import {
  LeadRadarInbox,
  leadRadarReplyKind,
  type LeadRadarHistoryReader,
} from "./leadRadarInbox";

// Only the explicitly provided isolated test database is touched, under a random schema.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Lead Radar isolated effect delivery", () => {
  const schema = `lr_transport_test_${randomUUID().replaceAll("-", "")}`;
  const config: LrConfig = {
    ownerId: 77001,
    token: "t".repeat(48),
    minIntervalSeconds: 120,
    contactIntervalSeconds: 86400,
    publicInquiryEnabled: false,
    binding: {
      org_id: "test-org",
      account_id: `lrtgua_${"a".repeat(32)}`,
      account_ref: "test_gateway_ref_0001",
      sender_fingerprint: "b".repeat(64),
    },
  };
  let admin: Pool, pool: Pool;
  let effect: LeadRadarEffects;
  const send =
    vi.fn<(request: DeliveryRequest) => Promise<{ messageId?: string }>>();
  let peerRef: string;
  let resolver = vi.fn();
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
      "015_lead_radar_effects.sql",
      "016_lead_radar_inbox.sql",
    ])
      await pool.query(
        await readFile(
          new URL(`../../migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    await pool.query(
      "ALTER TABLE delivery_campaigns ADD COLUMN photo_id uuid, ADD COLUMN photo_sha256 text"
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 19).toString("base64"));
    await pool.query(
      "TRUNCATE lead_radar_session_checks,lead_radar_inbox_outbox,lead_radar_inbox_cursors,lead_radar_peers,lead_radar_effects,delivery_resolutions,delivery_attempts,deliveries,delivery_campaigns,contact_permissions,contact_delivery_controls,sender_controls,delivery_worker_heartbeats RESTART IDENTITY CASCADE"
    );
    send.mockReset().mockResolvedValue({ messageId: "501" });
    resolver = vi.fn().mockResolvedValue({
      kind: "user",
      userId: "10001",
      accessHash: "-123456789",
      username: "testcompany",
    });
    effect = new LeadRadarEffects(
      pool,
      { send },
      async () => config.binding.sender_fingerprint,
      () => true,
      resolver,
      async () => "Telegram •••• 0001"
    );
    const result = await effect.resolve(config, config.binding, "testcompany");
    expect(result.status).toBe("resolved");
    peerRef = result.peer_ref!;
    await unpace();
  });
  async function unpace() {
    await pool.query(
      "UPDATE sender_controls SET next_send_at=now()-interval '1 second',cooldown_until=NULL,state='READY'"
    );
  }
  function command(
    effectId = "effect_0001",
    changes: Partial<LrCommand> = {}
  ): LrCommand {
    const draft = {
      schema: LR_SCHEMA,
      binding: config.binding,
      effect_id: effectId,
      recipient: peerRef,
      text: "Synthetic business question",
      authorization: {
        basis: "documented_consent" as const,
        reference: "fixture_authorization",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      paid_message_policy: "reject" as const,
      allow_paid_floodskip: false as const,
      parse_mode: "None" as const,
      ...changes,
    };
    return { ...draft, payload_sha256: commandDigest(draft) };
  }
  it("stores encrypted peers, returns no raw identities, refuses bots and changed/expired scopes", async () => {
    const row = (await pool.query("SELECT * FROM lead_radar_peers")).rows[0];
    expect(row.peer_secret).toMatch(/^enc:v1:/);
    expect(row.peer_secret).not.toContain("-123456789");
    expect(JSON.stringify(await effect.status(config))).not.toContain(
      "accessHash"
    );
    await pool.query(
      "UPDATE lead_radar_peers SET expires_at=now()-interval '1 second'"
    );
    expect(await effect.dispatch(config, command())).toMatchObject({
      state: "rejected",
      code: "peer_invalid",
    });
    resolver.mockResolvedValueOnce({ kind: "bot" });
    expect(
      await effect.resolve(config, config.binding, "anotherbot")
    ).toMatchObject({ status: "unresolved", kind: "bot", peer_ref: null });
    expect(send).not.toHaveBeenCalled();
    await expect(
      effect.resolve(
        config,
        { ...config.binding, account_ref: "different_reference" },
        "testcompany"
      )
    ).rejects.toThrow("SCOPE_MISMATCH");
  });
  it("persists exactly one effect and random id, returns accepted receipt without replay", async () => {
    const cmd = command();
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "accepted",
      provider_message_id: "501",
    });
    const restarted = new LeadRadarEffects(
      pool,
      { send },
      async () => config.binding.sender_fingerprint,
      () => true
    );
    expect(await restarted.dispatch(config, cmd)).toMatchObject({
      state: "accepted",
    });
    expect(await restarted.read(config, cmd)).toMatchObject({
      state: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      recipient: "chat:10001",
      randomId: effectRandomId(config, cmd.effect_id),
      resolvedPeer: { userId: "10001", accessHash: "-123456789" },
      message: cmd.text,
    });
    await expect(
      effect.dispatch(config, command(cmd.effect_id, { text: "different" }))
    ).rejects.toThrow("PAYLOAD_CONFLICT");
    await expect(
      effect.dispatch(
        config,
        command("effect_0002", {
          binding: { ...config.binding, org_id: "other-org" },
        })
      )
    ).rejects.toThrow("SCOPE_MISMATCH");
  });
  it("serializes dispatch, resolver, cancel and legacy lock on exact sender", async () => {
    let entered!: () => void, finish!: (value: { messageId: string }) => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    send.mockImplementationOnce(async () => {
      entered();
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const cmd = command();
    const active = effect.dispatch(config, cmd);
    await reached;
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "rejected",
      code: "flood_wait",
    });
    expect(
      await effect.resolve(config, config.binding, "differentuser")
    ).toMatchObject({ status: "blocked", reason_code: "sender_busy" });
    expect(await effect.cancel(config, cmd)).toMatchObject({
      state: "inflight",
    });
    const contender = await pool.connect();
    try {
      expect(
        (
          await contender.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked",
            [`tg-sender:${config.ownerId}:mtproto`]
          )
        ).rows[0].locked
      ).toBe(false);
    } finally {
      contender.release();
    }
    finish({ messageId: "502" });
    expect(await active).toMatchObject({ state: "accepted" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never retries an uncertain transport result and pauses sender", async () => {
    send.mockRejectedValueOnce(new Error("synthetic connection lost"));
    const cmd = command();
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "unknown",
    });
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "unknown",
    });
    expect(await effect.status(config)).toMatchObject({
      ready: false,
      reason_code: "sender_requires_review",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("recovers abandoned committed inflight as unknown without a transport call", async () => {
    const cmd = command();
    await pool.query(
      `INSERT INTO lead_radar_effects(owner_id,org_id,account_id,account_ref,sender_fingerprint,effect_id,payload_sha256,random_id,recipient,state,attempt_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'chat:10001','inflight',1)`,
      [
        config.ownerId,
        config.binding.org_id,
        config.binding.account_id,
        config.binding.account_ref,
        config.binding.sender_fingerprint,
        cmd.effect_id,
        cmd.payload_sha256,
        effectRandomId(config, cmd.effect_id),
      ]
    );
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "unknown",
    });
    expect(send).not.toHaveBeenCalled();
    expect(await effect.status(config)).toMatchObject({
      reason_code: "sender_requires_review",
    });
  });
  it("preserves unknown after losing DB lock during a send and never automatically replays", async () => {
    send.mockImplementationOnce(async request => {
      const locks = await pool.query(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND pid IN(SELECT pid FROM pg_stat_activity WHERE application_name=$1)`,
        [schema]
      );
      expect(locks.rows.length).toBe(1);
      const abort = new Promise<void>(resolve =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
      await admin.query("SELECT pg_terminate_backend($1)", [locks.rows[0].pid]);
      await abort;
      return { messageId: "503" };
    });
    const cmd = command();
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "unknown",
    });
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "unknown",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("durably holds FloodWait across instances, allows explicit same-id retry only after known rejection deadline", async () => {
    send.mockRejectedValueOnce(
      new DeliveryError("cooldown", "FLOOD_WAIT", 3600)
    );
    const cmd = command();
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      state: "rejected",
      code: "flood_wait",
      retry_after_seconds: 3600,
    });
    const restarted = new LeadRadarEffects(
      pool,
      { send },
      async () => config.binding.sender_fingerprint,
      () => true
    );
    expect(await restarted.status(config)).toMatchObject({
      ready: false,
      reason_code: "sender_cooldown",
    });
    expect(await restarted.dispatch(config, cmd)).toMatchObject({
      code: "flood_wait",
    });
    expect(send).toHaveBeenCalledTimes(1);
    await unpace();
    await pool.query(
      "UPDATE lead_radar_effects SET available_at=now()-interval '1 second'"
    );
    expect(await restarted.dispatch(config, cmd)).toMatchObject({
      state: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].randomId).toBe(send.mock.calls[1][0].randomId);
  });
  it("persists resolver FloodWait and rejects raw/foreign bridge references", async () => {
    resolver.mockRejectedValueOnce(
      new DeliveryError("cooldown", "FLOOD_WAIT", 1200)
    );
    expect(
      await effect.resolve(config, config.binding, "differentuser")
    ).toMatchObject({
      status: "blocked",
      reason_code: "sender_cooldown",
      retry_after_seconds: 1200,
    });
    expect(await effect.status(config)).toMatchObject({
      reason_code: "sender_cooldown",
    });
    await unpace();
    expect(
      await effect.dispatch(
        config,
        command("effect_0002", { recipient: `lrpeer:${"9".repeat(32)}` })
      )
    ).toMatchObject({ code: "peer_invalid" });
    await expect(
      effect.dispatch(
        config,
        command("effect_0003", { recipient: "username:testcompany" })
      )
    ).rejects.toThrow("INVALID_PAYLOAD");
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps cancellation tombstones and accepted cancellation honest", async () => {
    const cancelled = command();
    expect(await effect.cancel(config, cancelled)).toMatchObject({
      state: "cancelled",
    });
    expect(await effect.dispatch(config, cancelled)).toMatchObject({
      state: "cancelled",
    });
    expect(send).not.toHaveBeenCalled();
    const accepted = command("effect_0002");
    await effect.dispatch(config, accepted);
    expect(await effect.cancel(config, accepted)).toMatchObject({
      state: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("honors sticky username and canonical contact suppression", async () => {
    await pool.query(
      `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at) VALUES($1,'mtproto','username:testcompany',false,'fixture',now())`,
      [config.ownerId]
    );
    expect(await effect.dispatch(config, command())).toMatchObject({
      code: "privacy_restricted",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks stale credentials and existing legacy activity without stopping it", async () => {
    const drifted = new LeadRadarEffects(
      pool,
      { send },
      async () => "c".repeat(64),
      () => true
    );
    expect(await drifted.dispatch(config, command())).toMatchObject({
      code: "account_session_missing",
    });
    const old = new DeliveryService(pool);
    await old.setContactPermission({
      ownerId: config.ownerId,
      kind: "mtproto",
      recipient: "username:legacycompany",
      allowed: true,
      source: "fixture",
    });
    await old.enqueueCampaign({
      ownerId: config.ownerId,
      kind: "mtproto",
      broadcastId: 1,
      message: "legacy",
      recipients: ["username:legacycompany"],
      delaySeconds: 120,
      isDryRun: false,
      senderFingerprint: config.binding.sender_fingerprint,
    });
    expect(await effect.status(config)).toMatchObject({
      reason_code: "legacy_campaign_active",
    });
    expect(await effect.dispatch(config, command())).toMatchObject({
      code: "account_session_missing",
    });
    expect(
      (await pool.query("SELECT status FROM delivery_campaigns")).rows[0].status
    ).toBe("queued");
    expect(send).not.toHaveBeenCalled();
  });
  it("default-denies cold basis, requires complete authenticated evidence, prevents second contact across effect ids", async () => {
    const authorization: LrCommand["authorization"] = {
      basis: "public_business_inquiry",
      reference: "authorization_public",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      public_inquiry: {
        policy_version: "public-business-inquiry-v1",
        source_url_digest: "1".repeat(64),
        approval_id: `lrtgap_${"2".repeat(32)}`,
        selection_digest: "3".repeat(64),
        content_digest: "4".repeat(64),
        recipient_id: `lrtgcr_${"5".repeat(32)}`,
        first_contact_only: true,
      },
    };
    const cmd = command("public_effect_1", { authorization });
    expect(await effect.dispatch(config, cmd)).toMatchObject({
      code: "provider_rejected",
    });
    const enabled = { ...config, publicInquiryEnabled: true };
    await expect(
      effect.dispatch(
        enabled,
        command("public_effect_0", {
          authorization: { ...authorization, public_inquiry: undefined },
        })
      )
    ).rejects.toThrow("INVALID_PAYLOAD");
    expect(await effect.dispatch(enabled, cmd)).toMatchObject({
      state: "accepted",
    });
    await unpace();
    expect(
      await effect.dispatch(
        enabled,
        command("public_effect_2", { authorization })
      )
    ).toMatchObject({ code: "privacy_restricted" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT count(*) FROM contact_permissions")).rows[0]
        .count
    ).toBe("0");
  });
  it("legacy worker skips the claimed sender but still runs another owner and bots", async () => {
    const legacy = new DeliveryService(pool);
    for (const entry of [
      { ownerId: config.ownerId, kind: "mtproto" as const },
      { ownerId: config.ownerId + 1, kind: "mtproto" as const },
      { ownerId: config.ownerId, kind: "bot" as const },
    ]) {
      await legacy.setContactPermission({
        ...entry,
        recipient: "chat:20001",
        allowed: true,
        source: "fixture",
      });
      await legacy.enqueueCampaign({
        ...entry,
        broadcastId: 1,
        message: "fixture",
        recipients: ["chat:20001"],
        delaySeconds: 0,
        isDryRun: false,
        senderFingerprint: config.binding.sender_fingerprint,
      });
    }
    vi.stubEnv("LEAD_RADAR_INTEGRATION_ENABLED", "true");
    vi.stubEnv("LEAD_RADAR_INTEGRATION_OWNER_ID", String(config.ownerId));
    await expect(
      legacy.enqueueCampaign({
        ownerId: config.ownerId,
        kind: "mtproto",
        broadcastId: 2,
        message: "fixture",
        recipients: ["chat:20001"],
        delaySeconds: 0,
        isDryRun: false,
      })
    ).rejects.toThrow("LEAD_RADAR_SENDER_OWNED");
    await runWorkerOnce({
      pool,
      transport: { send },
      liveSendEnabled: true,
      contactMinIntervalSeconds: 0,
    });
    await runWorkerOnce({
      pool,
      transport: { send },
      liveSendEnabled: true,
      contactMinIntervalSeconds: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.some(
        ([r]) => r.kind === "mtproto" && r.ownerId === config.ownerId
      )
    ).toBe(false);
    const pending = await pool.query(
      "SELECT d.state FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id WHERE c.owner_id=$1 AND c.kind='mtproto'",
      [config.ownerId]
    );
    expect(pending.rows[0].state).toBe("pending");
  });

  it("captures only accepted LR peer replies, encrypts callback outbox and blocks locally on callback outage", async () => {
    await effect.dispatch(config, command());
    await unpace();
    const read = vi.fn<LeadRadarHistoryReader>().mockResolvedValue([
      {
        messageId: "502",
        occurredAt: new Date().toISOString(),
        text: "Please send the proposal",
        outgoing: false,
      },
    ]);
    const callback = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const inbox = new LeadRadarInbox(
      pool,
      read,
      callback,
      async () => config.binding.sender_fingerprint
    );
    expect(await inbox.tick(config, "k".repeat(43))).toEqual({
      polled: 1,
      delivered: 0,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0]).toMatchObject({
      peer: { userId: "10001", accessHash: "-123456789" },
      minMessageId: "501",
      limit: 20,
    });
    const outbox = (await pool.query("SELECT * FROM lead_radar_inbox_outbox"))
      .rows[0];
    expect(outbox.payload_secret).toMatch(/^enc:v1:/);
    expect(outbox.payload_secret).not.toContain("Please send");
    expect(outbox.state).toBe("pending");
    const payload = JSON.parse(String(callback.mock.calls[0][1]?.body));
    expect(payload.outboundEffectId).toBe("effect_0001");
    expect(payload.kind).toBe("reply");
    expect(payload.text).toBe("Please send the proposal");
    expect(callback.mock.calls[0][0]).toBe(
      "https://gptbot.uz/api/internal/lead-radar-inbox"
    );
    expect(callback.mock.calls[0][1]?.redirect).toBe("error");
    await unpace();
    await pool.query("DELETE FROM contact_delivery_controls");
    expect(await effect.dispatch(config, command("effect_0002"))).toMatchObject(
      { code: "privacy_restricted" }
    );
  });
  it("retries exactly the same callback after restart and records only complete applied acknowledgement", async () => {
    await effect.dispatch(config, command());
    await unpace();
    const read = vi.fn<LeadRadarHistoryReader>().mockResolvedValue([
      {
        messageId: "502",
        occurredAt: new Date().toISOString(),
        text: "\u0421\u0422\u041e\u041f!",
        outgoing: false,
      },
    ]);
    const requests: string[] = [];
    const callback = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        requests.push(String(init?.body));
        return Response.json({ accepted: true });
      });
    const inbox = new LeadRadarInbox(
      pool,
      read,
      callback,
      async () => config.binding.sender_fingerprint
    );
    await inbox.tick(config, "k".repeat(43));
    expect(
      (await pool.query("SELECT state FROM lead_radar_inbox_outbox")).rows[0]
        .state
    ).toBe("pending");
    await pool.query(
      "UPDATE lead_radar_inbox_outbox SET next_attempt_at=now()-interval '1 second'"
    );
    callback.mockImplementationOnce(async (_url, init) => {
      requests.push(String(init?.body));
      return Response.json({
        id: `lrinb_${"a".repeat(32)}`,
        replayed: true,
        workflowState: "applied",
      });
    });
    const restarted = new LeadRadarInbox(
      pool,
      read,
      callback,
      async () => config.binding.sender_fingerprint
    );
    expect(await restarted.tick(config, "k".repeat(43))).toEqual({
      polled: 0,
      delivered: 1,
    });
    expect(requests[0]).toBe(requests[1]);
    expect(JSON.parse(requests[0]).kind).toBe("opt_out");
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT state FROM lead_radar_inbox_outbox")).rows[0]
        .state
    ).toBe("delivered");
  });
  it("filters outgoing messages and deduplicates replayed history without discarding incoming cursor", async () => {
    await effect.dispatch(config, command());
    await unpace();
    const at = new Date().toISOString();
    const read = vi.fn<LeadRadarHistoryReader>().mockResolvedValue([
      {
        messageId: "502",
        occurredAt: at,
        text: "owner response",
        outgoing: true,
      },
      { messageId: "503", occurredAt: at, text: "reply", outgoing: false },
    ]);
    const callback = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: `lrinb_${"a".repeat(32)}`,
        replayed: false,
        workflowState: "applied",
      })
    );
    const inbox = new LeadRadarInbox(
      pool,
      read,
      callback,
      async () => config.binding.sender_fingerprint
    );
    await inbox.tick(config, "k".repeat(43));
    await unpace();
    await pool.query(
      "UPDATE lead_radar_inbox_cursors SET poll_after=now()-interval '1 second'"
    );
    await inbox.tick(config, "k".repeat(43));
    expect(
      (await pool.query("SELECT count(*) FROM lead_radar_inbox_outbox")).rows[0]
        .count
    ).toBe("1");
    expect(
      (await pool.query("SELECT last_message_id FROM lead_radar_inbox_cursors"))
        .rows[0].last_message_id
    ).toBe("503");
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("does not read unrelated peers, unconfirmed effects, changed sessions or sender with another lock", async () => {
    const read = vi.fn<LeadRadarHistoryReader>().mockResolvedValue([]),
      callback = vi.fn<typeof fetch>();
    const inbox = new LeadRadarInbox(
      pool,
      read,
      callback,
      async () => config.binding.sender_fingerprint
    );
    await inbox.tick(config, "k".repeat(43));
    expect(read).not.toHaveBeenCalled();
    await effect.dispatch(config, command());
    await unpace();
    const drift = new LeadRadarInbox(pool, read, callback, async () =>
      "c".repeat(64)
    );
    await drift.tick(config, "k".repeat(43));
    expect(read).not.toHaveBeenCalled();
    const lock = await pool.connect();
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      `tg-sender:${config.ownerId}:mtproto`,
    ]);
    try {
      await inbox.tick(config, "k".repeat(43));
      expect(read).not.toHaveBeenCalled();
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `tg-sender:${config.ownerId}:mtproto`,
      ]);
      lock.release();
    }
    await pool.query("UPDATE lead_radar_effects SET state='unknown'");
    await inbox.tick(config, "k".repeat(43));
    expect(read).not.toHaveBeenCalled();
  });
  it("persists history FloodWait and handles optout only using exact rules", async () => {
    await effect.dispatch(config, command());
    await unpace();
    const read = vi
      .fn<LeadRadarHistoryReader>()
      .mockRejectedValue(new DeliveryError("cooldown", "FLOOD_WAIT", 1800));
    const inbox = new LeadRadarInbox(
      pool,
      read,
      vi.fn<typeof fetch>(),
      async () => config.binding.sender_fingerprint
    );
    await inbox.tick(config, "k".repeat(43));
    expect(await effect.status(config)).toMatchObject({
      reason_code: "sender_cooldown",
    });
    await inbox.tick(config, "k".repeat(43));
    expect(read).toHaveBeenCalledOnce();
    expect(leadRadarReplyKind("stop!")).toBe("opt_out");
    expect(leadRadarReplyKind("I cannot stop thinking about your offer")).toBe(
      "reply"
    );
  });
  it("erases encrypted bodies after seven days and preserves event ledger", async () => {
    await effect.dispatch(config, command());
    await unpace();
    const inbox = new LeadRadarInbox(
      pool,
      vi.fn<LeadRadarHistoryReader>().mockResolvedValue([
        {
          messageId: "502",
          occurredAt: new Date().toISOString(),
          text: "reply",
          outgoing: false,
        },
      ]),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("unavailable", { status: 503 })),
      async () => config.binding.sender_fingerprint
    );
    await inbox.tick(config, "k".repeat(43));
    await pool.query(
      "UPDATE lead_radar_inbox_outbox SET expires_at=now()-interval '1 second'"
    );
    await inbox.tick(config, "k".repeat(43));
    const row = (
      await pool.query(
        "SELECT state,payload_secret,payload_sha256 FROM lead_radar_inbox_outbox"
      )
    ).rows[0];
    expect(row.state).toBe("expired");
    expect(row.payload_secret).toBeNull();
    expect(row.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("reports configuration separately from explicit verified provider session and revokes stale verification on failure", async () => {
    const verifier = vi.fn().mockResolvedValue(undefined);
    const checked = new LeadRadarEffects(
      pool,
      { send },
      async () => config.binding.sender_fingerprint,
      () => true,
      resolver,
      async () => "TG Sender",
      verifier
    );
    expect(await checked.status(config)).toMatchObject({
      ready: true,
      provider_verified_at: null,
    });
    expect(verifier).not.toHaveBeenCalled();
    const result = await checked.probe(config, config.binding);
    expect(result.provider_verified_at).toBeTruthy();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect((await checked.status(config)).provider_verified_at).toBe(
      result.provider_verified_at
    );
    expect(verifier).toHaveBeenCalledTimes(1);
    verifier.mockRejectedValueOnce(
      new DeliveryError("auth", "SESSION_REVOKED")
    );
    expect(await checked.probe(config, config.binding)).toMatchObject({
      ready: false,
      provider_verified_at: null,
    });
    expect(
      (await pool.query("SELECT state FROM sender_controls")).rows[0].state
    ).toBe("AUTH_REQUIRED");
    expect(send).not.toHaveBeenCalled();
  });
});
