import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  normalizeRecipient,
  senderKey,
  type EnqueueInput,
  type SenderKind,
} from "./types";

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export class DeliveryService {
  constructor(readonly pool: Pool) {}

  async enqueueCampaign(input: EnqueueInput) {
    const key = senderKey(input.ownerId, input.kind);
    if (!Number.isSafeInteger(input.broadcastId) || input.broadcastId <= 0)
      throw new Error("INVALID_BROADCAST");
    if (!input.message.trim() || input.message.length > 4096)
      throw new Error("INVALID_MESSAGE_LENGTH");
    if (
      !Number.isFinite(input.delaySeconds) ||
      input.delaySeconds < 0 ||
      input.delaySeconds > 86400
    )
      throw new Error("INVALID_DELAY");
    if (
      ![null, undefined, "None", "HTML", "Markdown", "MarkdownV2"].includes(
        input.parseMode
      )
    )
      throw new Error("INVALID_PARSE_MODE");
    if (
      input.senderFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/.test(input.senderFingerprint)
    )
      throw new Error("INVALID_SENDER_FINGERPRINT");
    const recipients = [...new Set(input.recipients.map(normalizeRecipient))];
    if (recipients.length === 0 || recipients.length > 100000)
      throw new Error("INVALID_AUDIENCE_SIZE");
    const scheduledAt = input.scheduledAt ?? new Date();
    if (
      !Number.isFinite(scheduledAt.getTime()) ||
      (input.expiresAt &&
        (!Number.isFinite(input.expiresAt.getTime()) ||
          input.expiresAt <= scheduledAt))
    )
      throw new Error("INVALID_DELIVERY_WINDOW");
    const parseMode =
      input.parseMode === "None" ? null : (input.parseMode ?? null);
    // A retry without scheduledAt retains the original schedule, but cannot change its message or audience.
    const snapshotHash = createHash("sha256")
      .update(
        JSON.stringify({
          message: input.message,
          parseMode,
          recipients: [...recipients].sort(),
          delay: input.delaySeconds,
          dry: input.isDryRun,
          scheduled: input.scheduledAt?.toISOString() ?? null,
          expires: input.expiresAt?.toISOString() ?? null,
          senderFingerprint: input.senderFingerprint ?? null,
        })
      )
      .digest("hex");
    return transaction(this.pool, async client => {
      await client.query(
        "INSERT INTO sender_controls(sender_key,owner_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [key, input.ownerId, input.kind]
      );
      const inserted = await client.query(
        `INSERT INTO delivery_campaigns(owner_id,kind,broadcast_id,sender_key,snapshot_hash,message,parse_mode,delay_seconds,is_dry_run,scheduled_at,expires_at,sender_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(owner_id,kind,broadcast_id) DO NOTHING RETURNING id`,
        [
          input.ownerId,
          input.kind,
          input.broadcastId,
          key,
          snapshotHash,
          input.message,
          parseMode,
          input.delaySeconds,
          input.isDryRun,
          scheduledAt,
          input.expiresAt ?? null,
          input.senderFingerprint ?? null,
        ]
      );
      if (!inserted.rowCount) {
        const { rows } = await client.query(
          "SELECT id,snapshot_hash FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3",
          [input.ownerId, input.kind, input.broadcastId]
        );
        if (rows[0]?.snapshot_hash !== snapshotHash)
          throw new Error("CAMPAIGN_SNAPSHOT_CONFLICT");
        return {
          campaignId: String(rows[0].id),
          enqueued: false,
          total: recipients.length,
        };
      }
      const campaignId = String(inserted.rows[0].id);
      // One INSERT with bounded batches avoids both per-recipient round trips and PG parameter limits.
      for (let offset = 0; offset < recipients.length; offset += 1000) {
        const batch = recipients.slice(offset, offset + 1000);
        const randomIds = batch.map(() =>
          (
            randomBytes(8).readBigUInt64BE() & ((1n << 63n) - 1n) || 1n
          ).toString()
        );
        await client.query(
          `INSERT INTO deliveries(campaign_id,recipient,random_id,available_at)
          SELECT $1,recipient,random_id,$4 FROM unnest($2::text[],$3::text[]) AS t(recipient,random_id)`,
          [campaignId, batch, randomIds, scheduledAt]
        );
      }
      return { campaignId, enqueued: true, total: recipients.length };
    });
  }

  async getProgress(ownerId: number, kind: SenderKind, broadcastId: number) {
    senderKey(ownerId, kind);
    const result = await this.pool.query(
      `SELECT c.id,c.status,c.is_dry_run,c.scheduled_at,c.expires_at,c.cancel_requested_at,c.completed_at,
      s.state AS sender_state,s.cooldown_until,s.reason AS sender_reason,
      COUNT(d.id)::int AS total,
      COUNT(*) FILTER(WHERE d.state='accepted')::int AS accepted,
      COUNT(*) FILTER(WHERE d.state='dry_run')::int AS dry_run,
      COUNT(*) FILTER(WHERE d.state='pending')::int AS pending,
      COUNT(*) FILTER(WHERE d.state='inflight')::int AS inflight,
      COUNT(*) FILTER(WHERE d.state='failed')::int AS failed,
      COUNT(*) FILTER(WHERE d.state='suppressed')::int AS suppressed,
      COUNT(*) FILTER(WHERE d.state='unknown')::int AS unknown,
      COUNT(*) FILTER(WHERE d.state='cancelled')::int AS cancelled,
      COUNT(*) FILTER(WHERE d.state='expired')::int AS expired,
      MIN(d.available_at) FILTER(WHERE d.state='pending') AS next_delivery_at
      FROM delivery_campaigns c JOIN sender_controls s ON s.sender_key=c.sender_key LEFT JOIN deliveries d ON d.campaign_id=c.id
      WHERE c.owner_id=$1 AND c.kind=$2 AND c.broadcast_id=$3 GROUP BY c.id,s.sender_key`,
      [ownerId, kind, broadcastId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      campaignId: String(row.id),
      status: String(row.status),
      running: ["queued", "running", "stopping"].includes(row.status),
      total: row.total as number,
      totalRecipients: row.total as number,
      accepted: row.accepted as number,
      sent: row.accepted as number,
      sentCount: row.accepted as number,
      dryRun: row.dry_run as number,
      failed: row.failed as number,
      failedCount: row.failed as number,
      pending: row.pending as number,
      inflight: row.inflight as number,
      suppressed: row.suppressed as number,
      unknown: row.unknown as number,
      cancelled: row.cancelled as number,
      expired: row.expired as number,
      isDryRun: row.is_dry_run as boolean,
      scheduledAt: row.scheduled_at as Date,
      expiresAt: row.expires_at as Date | null,
      cancelRequestedAt: row.cancel_requested_at as Date | null,
      completedAt: row.completed_at as Date | null,
      nextDeliveryAt: row.next_delivery_at as Date | null,
      sender: {
        state: row.sender_state as string,
        cooldownUntil: row.cooldown_until as Date | null,
        reason: row.sender_reason as string | null,
      },
    };
  }

  async cancelCampaign(ownerId: number, kind: SenderKind, broadcastId: number) {
    senderKey(ownerId, kind);
    return transaction(this.pool, async client => {
      const result = await client.query(
        "SELECT id,status FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3 FOR UPDATE",
        [ownerId, kind, broadcastId]
      );
      const campaign = result.rows[0];
      if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
      if (!["queued", "running", "stopping"].includes(campaign.status))
        return { status: String(campaign.status), acknowledged: true };
      await client.query(
        `UPDATE deliveries SET state='cancelled',last_error='OWNER_CANCELLED',updated_at=now() WHERE campaign_id=$1 AND state='pending'`,
        [campaign.id]
      );
      const inflight = await client.query(
        `SELECT 1 FROM deliveries WHERE campaign_id=$1 AND state='inflight' LIMIT 1`,
        [campaign.id]
      );
      const status = inflight.rowCount ? "stopping" : "stopped";
      await client.query(
        `UPDATE delivery_campaigns SET status=$2,cancel_requested_at=COALESCE(cancel_requested_at,now()),completed_at=CASE WHEN $2='stopped' THEN now() ELSE NULL END WHERE id=$1`,
        [campaign.id, status]
      );
      return { status, acknowledged: status === "stopped" };
    });
  }

  async resumeCampaign(ownerId: number, kind: SenderKind, broadcastId: number) {
    senderKey(ownerId, kind);
    return transaction(this.pool, async client => {
      const result = await client.query(
        "SELECT id,status,expires_at FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3 FOR UPDATE",
        [ownerId, kind, broadcastId]
      );
      const campaign = result.rows[0];
      if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
      if (campaign.status !== "stopped")
        throw new Error("ONLY_STOPPED_CAMPAIGN_CAN_RESUME");
      if (campaign.expires_at && new Date(campaign.expires_at) <= new Date())
        throw new Error("CAMPAIGN_EXPIRED");
      const resumed = await client.query(
        `UPDATE deliveries SET state='pending',last_error=NULL,available_at=now(),updated_at=now() WHERE campaign_id=$1 AND state='cancelled' AND last_error='OWNER_CANCELLED'`,
        [campaign.id]
      );
      if (!resumed.rowCount) throw new Error("NO_CANCELLED_DELIVERIES");
      await client.query(
        `UPDATE delivery_campaigns SET status='queued',cancel_requested_at=NULL,completed_at=NULL WHERE id=$1`,
        [campaign.id]
      );
      return { resumed: resumed.rowCount };
    });
  }

  async getDeliveryLogs(
    ownerId: number,
    kind: SenderKind,
    broadcastId: number,
    pagination: { limit?: number; offset?: number } = {}
  ) {
    senderKey(ownerId, kind);
    const limit = Math.max(
      1,
      Math.min(500, Math.trunc(pagination.limit ?? 100))
    );
    const offset = Math.max(0, Math.trunc(pagination.offset ?? 0));
    const params = [ownerId, kind, broadcastId];
    const [count, rows] = await Promise.all([
      this.pool.query(
        "SELECT COUNT(*)::int AS total FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id WHERE c.owner_id=$1 AND c.kind=$2 AND c.broadcast_id=$3",
        params
      ),
      this.pool.query(
        `SELECT d.id,d.recipient,d.state,d.message_id,d.last_error,d.updated_at FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id
        WHERE c.owner_id=$1 AND c.kind=$2 AND c.broadcast_id=$3 ORDER BY d.id LIMIT $4 OFFSET $5`,
        [...params, limit, offset]
      ),
    ]);
    return {
      total: count.rows[0].total as number,
      limit,
      offset,
      items: rows.rows.map(row => ({
        id: String(row.id),
        recipient: String(row.recipient),
        chatId: String(row.recipient),
        status: String(row.state),
        success: row.state === "accepted",
        messageId: row.message_id as string | null,
        errorMessage: row.last_error as string | null,
        sentAt: row.updated_at as Date,
      })),
    };
  }

  async resolveUnknown(input: {
    ownerId: number;
    kind: SenderKind;
    broadcastId: number;
    deliveryIds: string[];
    resolution: "accepted" | "cancelled";
    evidence: string;
  }) {
    senderKey(input.ownerId, input.kind);
    if (!["accepted", "cancelled"].includes(input.resolution))
      throw new Error("INVALID_RESOLUTION");
    const evidence = input.evidence.trim();
    if (evidence.length < 10 || evidence.length > 2000)
      throw new Error("RESOLUTION_EVIDENCE_REQUIRED");
    const ids = [...new Set(input.deliveryIds)];
    if (
      !ids.length ||
      ids.length > 500 ||
      ids.some(id => !/^[1-9]\d{0,18}$/.test(id))
    )
      throw new Error("INVALID_DELIVERY_IDS");
    return transaction(this.pool, async client => {
      const campaignResult = await client.query(
        "SELECT id FROM delivery_campaigns WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3 FOR UPDATE",
        [input.ownerId, input.kind, input.broadcastId]
      );
      if (!campaignResult.rowCount) throw new Error("CAMPAIGN_NOT_FOUND");
      const campaignId = campaignResult.rows[0].id;
      const selected = await client.query(
        "SELECT id,state FROM deliveries WHERE campaign_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE",
        [campaignId, ids]
      );
      if (
        selected.rowCount !== ids.length ||
        selected.rows.some(row => row.state !== "unknown")
      )
        throw new Error("ONLY_UNKNOWN_DELIVERIES_CAN_RESOLVE");
      await client.query(
        `INSERT INTO delivery_resolutions(delivery_id,owner_id,resolution,evidence)
        SELECT id,$3,$4,$5 FROM deliveries WHERE campaign_id=$1 AND id=ANY($2::bigint[])`,
        [campaignId, ids, input.ownerId, input.resolution, evidence]
      );
      // These states close uncertainty. They are never queued by resolve or a later campaign resume.
      await client.query(
        `UPDATE deliveries SET state=$3,last_error=$4,updated_at=now() WHERE campaign_id=$1 AND id=ANY($2::bigint[]) AND state='unknown'`,
        [
          campaignId,
          ids,
          input.resolution,
          input.resolution === "accepted"
            ? "UNKNOWN_VERIFIED_ACCEPTED"
            : "UNKNOWN_CLOSED_WITHOUT_RETRY",
        ]
      );
      await client.query(
        `UPDATE delivery_campaigns c SET status=CASE
        WHEN cancel_requested_at IS NOT NULL THEN 'stopped'
        WHEN EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='unknown') THEN 'review_required'
        WHEN expires_at<=now() AND EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='expired') THEN 'expired'
        ELSE 'completed' END,completed_at=now()
        WHERE c.id=$1 AND c.status<>'failed' AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state IN ('pending','inflight'))`,
        [campaignId]
      );
      return { resolved: selected.rowCount, resolution: input.resolution };
    });
  }

  async setContactPermission(input: {
    ownerId: number;
    kind: SenderKind;
    recipient: string;
    allowed: boolean;
    source: string;
    explicitResubscribe?: boolean;
  }) {
    senderKey(input.ownerId, input.kind);
    if (input.source.trim().length < 3 || input.source.length > 256)
      throw new Error("PERMISSION_SOURCE_REQUIRED");
    const recipient = normalizeRecipient(input.recipient);
    const result = await this.pool.query(
      `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $4 THEN NULL ELSE now() END)
      ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET
        allowed=CASE WHEN contact_permissions.suppressed_at IS NOT NULL AND NOT $6 THEN false ELSE EXCLUDED.allowed END,
        source=CASE WHEN contact_permissions.suppressed_at IS NOT NULL AND NOT $6 AND EXCLUDED.allowed THEN contact_permissions.source ELSE EXCLUDED.source END,
        suppressed_at=CASE WHEN NOT EXCLUDED.allowed THEN COALESCE(contact_permissions.suppressed_at,now())
          WHEN $6 THEN NULL ELSE contact_permissions.suppressed_at END,updated_at=now()
      RETURNING recipient,allowed,source,suppressed_at,updated_at`,
      [
        input.ownerId,
        input.kind,
        recipient,
        input.allowed,
        input.source.trim(),
        input.explicitResubscribe === true,
      ]
    );
    return result.rows[0] as {
      recipient: string;
      allowed: boolean;
      source: string;
      suppressed_at: Date | null;
      updated_at: Date;
    };
  }

  async listContactPermissions(
    ownerId: number,
    kind: SenderKind,
    pagination: { limit?: number; offset?: number } = {}
  ) {
    senderKey(ownerId, kind);
    const limit = Math.max(
      1,
      Math.min(500, Math.trunc(pagination.limit ?? 100))
    );
    const offset = Math.max(0, Math.trunc(pagination.offset ?? 0));
    const result = await this.pool.query(
      "SELECT recipient,allowed,source,suppressed_at,updated_at FROM contact_permissions WHERE owner_id=$1 AND kind=$2 ORDER BY recipient LIMIT $3 OFFSET $4",
      [ownerId, kind, limit, offset]
    );
    return result.rows as {
      recipient: string;
      allowed: boolean;
      source: string;
      suppressed_at: Date | null;
      updated_at: Date;
    }[];
  }

  async getSenderStatus(ownerId: number, kind: SenderKind) {
    const key = senderKey(ownerId, kind);
    const result = await this.pool.query(
      "SELECT state,cooldown_until,next_send_at,reason,updated_at FROM sender_controls WHERE sender_key=$1",
      [key]
    );
    const row = result.rows[0];
    return row
      ? {
          state: row.state as string,
          cooldownUntil: row.cooldown_until as Date | null,
          nextSendAt: row.next_send_at as Date,
          reason: row.reason as string | null,
          updatedAt: row.updated_at as Date,
        }
      : {
          state: "READY",
          cooldownUntil: null,
          nextSendAt: null,
          reason: null,
          updatedAt: null,
        };
  }

  async resumeSender(ownerId: number, kind: SenderKind) {
    const key = senderKey(ownerId, kind);
    // Explicit acknowledgement can clear a restriction, but never shortens a mandatory wait.
    await this.pool.query(
      `UPDATE sender_controls SET state=CASE WHEN cooldown_until>now() THEN 'COOLDOWN' ELSE 'READY' END,
      reason=CASE WHEN cooldown_until>now() THEN reason ELSE NULL END,updated_at=now() WHERE sender_key=$1`,
      [key]
    );
    return this.getSenderStatus(ownerId, kind);
  }

  async getWorkerStatus() {
    const result = await this.pool
      .query(`SELECT worker_id,live_send_enabled,last_seen_at,last_success_at,last_error,last_seen_at>now()-interval '30 seconds' AS healthy
      FROM delivery_worker_heartbeats ORDER BY last_seen_at DESC LIMIT 20`);
    return result.rows as {
      worker_id: string;
      live_send_enabled: boolean;
      last_seen_at: Date;
      last_success_at: Date | null;
      last_error: string | null;
      healthy: boolean;
    }[];
  }
}
