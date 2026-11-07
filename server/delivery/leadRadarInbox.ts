import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { decryptSecret, encryptSecret } from "../security/secrets";
import {
  classifyIntegrationFailure,
  integrationConfig,
  type LrConfig,
} from "./leadRadarEffects";
import { getPool } from "../connection";
import { getMtprotoSession } from "../db";
import { readLeadRadarReplies } from "../telegramTransport";
import { senderKey } from "./types";

const CALLBACK = "https://gptbot.uz/api/internal/lead-radar-inbox";
export interface LeadRadarIncomingMessage {
  messageId: string;
  occurredAt: string;
  text: string;
  outgoing: boolean;
}
export type LeadRadarHistoryReader = (input: {
  ownerId: number;
  fingerprint: string;
  peer: { userId: string; accessHash: string };
  minMessageId: string;
  limit: number;
  signal: AbortSignal;
}) => Promise<LeadRadarIncomingMessage[]>;
const stopWords = new Set([
  "stop",
  "стоп",
  "отписаться",
  "не пишите",
  "не пишите мне",
  "не пишите больше",
  "отписка",
  "yozmang",
  "bezovta qilmang",
  "unsubscribe",
]);
export function leadRadarReplyKind(text: string): "reply" | "opt_out" {
  return stopWords.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/u, "")
  )
    ? "opt_out"
    : "reply";
}
function clipText(text: string) {
  return [...text.replace(/\0/gu, "")].slice(0, 4096).join("");
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function scope(config: LrConfig) {
  return [config.ownerId, config.binding.org_id, config.binding.account_id];
}

/** Bounded inbound-only poller; it has no send/launch operation or campaign scheduler. */
export class LeadRadarInbox {
  constructor(
    private readonly pool: Pool,
    private readonly readHistory: LeadRadarHistoryReader,
    private readonly http: typeof fetch,
    private readonly fingerprint: (ownerId: number) => Promise<string | null>
  ) {}
  async tick(
    config: LrConfig,
    callbackToken: string,
    deadline = Date.now() + 15000
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(callbackToken))
      return { polled: 0, delivered: 0 };
    await this.pool.query(
      `UPDATE lead_radar_inbox_outbox SET payload_secret=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END,lease_until=NULL WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND expires_at<=now() AND payload_secret IS NOT NULL`,
      scope(config)
    );
    let polled = 0;
    if (Date.now() + 10000 < deadline) polled = await this.collect(config);
    let delivered = 0;
    for (let i = 0; i < 2 && Date.now() + 4000 < deadline; i++) {
      const result = await this.deliverOne(
        config,
        callbackToken,
        Math.min(7000, deadline - Date.now() - 1000)
      );
      if (result === null) break;
      if (result) delivered++;
    }
    return { polled, delivered };
  }
  private async collect(config: LrConfig): Promise<number> {
    const client = await this.pool.connect();
    const key = senderKey(config.ownerId, "mtproto");
    const lockName = `tg-sender:${key}`;
    let locked = false,
      lost = false;
    const controller = new AbortController();
    const onError = () => {
      lost = true;
      controller.abort();
    };
    client.on("error", onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      locked =
        (
          await client.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked",
            [lockName]
          )
        ).rows[0].locked === true;
      if (!locked) return 0;
      if (
        (await this.fingerprint(config.ownerId)) !==
        config.binding.sender_fingerprint
      )
        return 0;
      const state = (
        await client.query(
          `SELECT state,cooldown_until,next_send_at FROM sender_controls WHERE sender_key=$1`,
          [key]
        )
      ).rows[0];
      if (
        !state ||
        !["READY", "COOLDOWN"].includes(state.state) ||
        Math.max(
          new Date(state.cooldown_until ?? 0).getTime(),
          new Date(state.next_send_at ?? 0).getTime()
        ) > Date.now()
      )
        return 0;
      const active = (
        await client.query(
          `SELECT EXISTS(SELECT 1 FROM delivery_campaigns c WHERE c.sender_key=$1 AND (c.status IN ('queued','running','stopping') OR EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='inflight'))) active`,
          [key]
        )
      ).rows[0].active;
      if (active) return 0;
      const peer = (
        await client.query(
          `SELECT p.peer_ref,p.peer_secret,p.username,COALESCE(c.last_message_id,min(e.provider_message_id::bigint))::text last_id
    FROM lead_radar_peers p JOIN lead_radar_effects e ON e.owner_id=p.owner_id AND e.org_id=p.org_id AND e.account_id=p.account_id AND e.peer_ref=p.peer_ref AND e.sender_fingerprint=p.sender_fingerprint
    LEFT JOIN lead_radar_inbox_cursors c ON c.owner_id=p.owner_id AND c.org_id=p.org_id AND c.account_id=p.account_id AND c.sender_fingerprint=p.sender_fingerprint AND c.peer_ref=p.peer_ref
    WHERE p.owner_id=$1 AND p.org_id=$2 AND p.account_id=$3 AND p.account_ref=$4 AND p.sender_fingerprint=$5 AND e.state='accepted' AND e.updated_at>now()-interval '7 days' AND (c.poll_after IS NULL OR c.poll_after<=now())
    GROUP BY p.peer_ref,p.peer_secret,p.username,c.last_message_id,c.poll_after ORDER BY c.poll_after ASC NULLS FIRST,p.peer_ref LIMIT 1`,
          [
            ...scope(config),
            config.binding.account_ref,
            config.binding.sender_fingerprint,
          ]
        )
      ).rows[0];
      if (!peer) return 0;
      const decoded = JSON.parse(
        decryptSecret(
          peer.peer_secret,
          `lead-radar-peer:${config.ownerId}:${config.binding.org_id}:${config.binding.account_id}:${peer.peer_ref}`
        )
      );
      if (
        !/^[1-9][0-9]{0,19}$/.test(decoded.userId) ||
        !/^-?[0-9]{1,20}$/.test(decoded.accessHash)
      )
        return 0;
      await client.query(
        `UPDATE sender_controls SET next_send_at=GREATEST(next_send_at,now()+interval '5 seconds'),updated_at=now() WHERE sender_key=$1`,
        [key]
      );
      timer = setTimeout(() => controller.abort(), 9000);
      const messages = await this.readHistory({
        ownerId: config.ownerId,
        fingerprint: config.binding.sender_fingerprint,
        peer: decoded,
        minMessageId: peer.last_id,
        limit: 20,
        signal: controller.signal,
      });
      if (lost || controller.signal.aborted) return 0;
      if (messages.length > 20) throw new Error("HISTORY_BOUND_EXCEEDED");
      const sorted = messages
        .filter(
          m =>
            /^[1-9][0-9]{0,9}$/.test(m.messageId) &&
            BigInt(m.messageId) > BigInt(peer.last_id)
        )
        .sort((a, b) => Number(BigInt(a.messageId) - BigInt(b.messageId)));
      let lastId = peer.last_id;
      await client.query("BEGIN");
      try {
        for (const message of sorted) {
          if (
            !Number.isFinite(Date.parse(message.occurredAt)) ||
            Date.parse(message.occurredAt) > Date.now() + 300000
          )
            throw new Error("INVALID_HISTORY_DATE");
          lastId = message.messageId;
          if (message.outgoing) continue;
          const effect = (
            await client.query(
              `SELECT effect_id FROM lead_radar_effects WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND sender_fingerprint=$4 AND peer_ref=$5 AND state='accepted' AND provider_message_id::bigint<$6::bigint ORDER BY provider_message_id::bigint DESC LIMIT 1`,
              [
                ...scope(config),
                config.binding.sender_fingerprint,
                peer.peer_ref,
                message.messageId,
              ]
            )
          ).rows[0];
          if (!effect) continue;
          const text = clipText(message.text),
            kind = leadRadarReplyKind(text);
          const eventId = `tgs:${config.binding.account_id}:${sha(`${config.ownerId}:${config.binding.sender_fingerprint}:${decoded.userId}`).slice(0, 16)}:${message.messageId}`;
          const payload = {
            schemaVersion: 1,
            orgId: config.binding.org_id,
            accountId: config.binding.account_id,
            outboundEffectId: effect.effect_id,
            externalEventId: eventId,
            kind,
            occurredAt: new Date(message.occurredAt).toISOString(),
            ...(text ? { text } : {}),
          };
          const serialized = JSON.stringify(payload);
          if (Buffer.byteLength(serialized) > 24576)
            throw new Error("INBOX_BODY_TOO_LARGE");
          const secret = encryptSecret(
            serialized,
            `lead-radar-inbox:${config.ownerId}:${eventId}`
          );
          await client.query(
            `INSERT INTO lead_radar_inbox_outbox(owner_id,org_id,account_id,event_id,effect_id,kind,payload_secret,payload_sha256,occurred_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+interval '7 days') ON CONFLICT DO NOTHING`,
            [
              ...scope(config),
              eventId,
              effect.effect_id,
              kind,
              secret,
              sha(serialized),
              payload.occurredAt,
            ]
          );
          // Stop repeated automation locally even while the callback is unavailable.
          for (const alias of [
            `chat:${decoded.userId}`,
            `username:${peer.username}`,
          ])
            await client.query(
              `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at) VALUES($1,'mtproto',$2,false,$3,now()) ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET allowed=false,suppressed_at=COALESCE(contact_permissions.suppressed_at,now()),source=EXCLUDED.source,updated_at=now()`,
              [config.ownerId, alias, `lead_radar:inbound_${kind}`]
            );
        }
        await client.query(
          `INSERT INTO lead_radar_inbox_cursors(owner_id,org_id,account_id,sender_fingerprint,peer_ref,last_message_id,poll_after) VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds') ON CONFLICT(owner_id,org_id,account_id,sender_fingerprint,peer_ref) DO UPDATE SET last_message_id=GREATEST(lead_radar_inbox_cursors.last_message_id,EXCLUDED.last_message_id),poll_after=EXCLUDED.poll_after,updated_at=now()`,
          [
            ...scope(config),
            config.binding.sender_fingerprint,
            peer.peer_ref,
            lastId,
          ]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      return 1;
    } catch (error) {
      const classified = classifyIntegrationFailure(error);
      if (!lost && classified.code === "flood_wait")
        await client.query(
          `UPDATE sender_controls SET state='COOLDOWN',cooldown_until=GREATEST(COALESCE(cooldown_until,now()),now()+$2*interval '1 second'),reason='LR_INBOX_FLOOD_WAIT',updated_at=now() WHERE sender_key=$1`,
          [key, classified.retry_after_seconds]
        );
      return 0;
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (locked && !lost)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            lockName,
          ])
          .catch(() => {
            lost = true;
          });
      client.removeListener("error", onError);
      client.release(lost);
    }
  }
  private async deliverOne(
    config: LrConfig,
    token: string,
    timeoutMs: number
  ): Promise<boolean | null> {
    const result = await this.pool.query(
      `UPDATE lead_radar_inbox_outbox o SET lease_until=now()+interval '30 seconds',attempt_count=attempt_count+1 WHERE (owner_id,org_id,account_id,event_id) IN(SELECT owner_id,org_id,account_id,event_id FROM lead_radar_inbox_outbox WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND state='pending' AND next_attempt_at<=now() AND expires_at>now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_attempt_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      scope(config)
    );
    const event = result.rows[0];
    if (!event) return null;
    let delivered = false,
      conflict = false;
    try {
      const body = decryptSecret(
        event.payload_secret,
        `lead-radar-inbox:${config.ownerId}:${event.event_id}`
      );
      if (sha(body) !== event.payload_sha256)
        throw new Error("OUTBOX_DIGEST_MISMATCH");
      const response = await this.http(CALLBACK, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      });
      conflict = response.status === 409;
      if (response.status === 200 && response.body) {
        const reader = response.body.getReader();
        let text = "",
          size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 2048) {
              await reader.cancel();
              throw new Error("CALLBACK_BODY_TOO_LARGE");
            }
            text += new TextDecoder().decode(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const ack = JSON.parse(text);
        delivered =
          typeof ack.id === "string" &&
          /^lrinb_[a-f0-9]{32}$/.test(ack.id) &&
          typeof ack.replayed === "boolean" &&
          ack.workflowState === "applied";
      } else await response.body?.cancel();
    } catch {
      /* The same event/payload will retry; never advance to delivered without the full callback acknowledgement. */
    }
    await this.pool.query(
      `UPDATE lead_radar_inbox_outbox SET state=$5,delivered_at=CASE WHEN $6 THEN now() ELSE NULL END,lease_until=NULL,next_attempt_at=now()+$7*interval '1 second' WHERE owner_id=$1 AND org_id=$2 AND account_id=$3 AND event_id=$4 AND attempt_count=$8`,
      [
        ...scope(config),
        event.event_id,
        delivered ? "delivered" : conflict ? "conflict" : "pending",
        delivered,
        Math.min(3600, 30 * 2 ** Math.min(event.attempt_count, 7)),
        event.attempt_count,
      ]
    );
    return delivered;
  }
}

export async function tickLeadRadarInbox(
  options: { pool?: Pool; deadline?: number } = {}
) {
  if (process.env.LEAD_RADAR_INBOX_ENABLED !== "true")
    return { polled: 0, delivered: 0 };
  const config = integrationConfig(),
    token = process.env.LEAD_RADAR_OUTREACH_INBOX_TOKEN ?? "";
  if (!config || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return { polled: 0, delivered: 0 };
  const producer = new LeadRadarInbox(
    options.pool ?? getPool(),
    readLeadRadarReplies,
    fetch,
    async ownerId => {
      const session = await getMtprotoSession(ownerId);
      return session?.isActive && session.sessionString
        ? sha(session.sessionString)
        : null;
    }
  );
  return producer.tick(config, token, options.deadline);
}
