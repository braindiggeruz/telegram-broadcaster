import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../connection";
import {
  DeliveryError,
  safeCode,
  type ParseMode,
  type SenderKind,
  type WorkerOptions,
} from "./types";

type Claim = {
  id: string;
  campaign_id: string;
  owner_id: string;
  kind: SenderKind;
  sender_key: string;
  recipient: string;
  message: string;
  parse_mode: ParseMode;
  delay_seconds: number;
  is_dry_run: boolean;
  random_id: string;
  attempt_id: string;
  sender_fingerprint: string | null;
};

function nonnegativeSetting(
  value: number | string | undefined,
  fallback: number
) {
  const number = Number(value);
  return value !== undefined && Number.isFinite(number) && number >= 0
    ? number
    : fallback;
}

/** Health contains no account, content, or credential data. */
export async function recordWorkerHeartbeat(
  pool: Pool,
  workerId: string,
  liveSendEnabled: boolean,
  error?: string
) {
  await pool.query(
    `INSERT INTO delivery_worker_heartbeats(worker_id,live_send_enabled,last_error) VALUES($1,$2,$3)
    ON CONFLICT(worker_id) DO UPDATE SET live_send_enabled=EXCLUDED.live_send_enabled,last_seen_at=now(),
      last_error=COALESCE(EXCLUDED.last_error,delivery_worker_heartbeats.last_error)`,
    [workerId, liveSendEnabled, error ? safeCode(error) : null]
  );
}

/** Only a completed automation+delivery iteration may clear a worker failure. */
export async function recordWorkerSuccess(
  pool: Pool,
  workerId: string,
  liveSendEnabled: boolean
) {
  await pool.query(
    `INSERT INTO delivery_worker_heartbeats(worker_id,live_send_enabled,last_success_at,last_error) VALUES($1,$2,now(),NULL)
    ON CONFLICT(worker_id) DO UPDATE SET live_send_enabled=EXCLUDED.live_send_enabled,last_seen_at=now(),last_success_at=now(),last_error=NULL`,
    [workerId, liveSendEnabled]
  );
}

async function finishCampaigns(client: PoolClient, key: string) {
  // Cancellation is acknowledged only after every active claim is settled or conservatively recovered.
  await client.query(
    `UPDATE delivery_campaigns c SET status=CASE
      WHEN c.cancel_requested_at IS NOT NULL THEN 'stopped'
      WHEN EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='unknown') THEN 'review_required'
      WHEN c.expires_at<=now() AND EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='expired') THEN 'expired'
      ELSE 'completed' END,completed_at=now()
    WHERE c.sender_key=$1 AND c.status IN ('queued','running','stopping')
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state IN ('pending','inflight'))`,
    [key]
  );
}

async function housekeeping(
  client: PoolClient,
  key: string,
  contactInterval: number
) {
  // Owning the session lock proves no other healthy worker owns this sender. An abandoned
  // in-flight request may nevertheless have reached Telegram, so it is never returned to pending.
  await client.query(
    `INSERT INTO contact_delivery_controls(sender_key,recipient,next_send_at)
    SELECT DISTINCT c.sender_key,d.recipient,now()+$2*interval '1 second' FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id
    WHERE c.sender_key=$1 AND d.state='inflight' ON CONFLICT(sender_key,recipient) DO UPDATE SET next_send_at=GREATEST(contact_delivery_controls.next_send_at,EXCLUDED.next_send_at)`,
    [key, contactInterval]
  );
  await client.query(
    `UPDATE delivery_attempts a SET state='unknown',error_code='WORKER_INTERRUPTED',completed_at=now()
    FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id
    WHERE a.id=d.attempt_id AND d.state='inflight' AND c.sender_key=$1`,
    [key]
  );
  await client.query(
    `UPDATE deliveries d SET state='unknown',last_error='WORKER_INTERRUPTED',updated_at=now()
    FROM delivery_campaigns c WHERE c.id=d.campaign_id AND c.sender_key=$1 AND d.state='inflight'`,
    [key]
  );
  await client.query(
    `UPDATE deliveries d SET state=CASE WHEN c.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
    last_error=CASE WHEN c.cancel_requested_at IS NOT NULL THEN 'OWNER_CANCELLED' ELSE 'CAMPAIGN_EXPIRED' END,updated_at=now()
    FROM delivery_campaigns c WHERE c.id=d.campaign_id AND c.sender_key=$1 AND d.state='pending'
      AND (c.cancel_requested_at IS NOT NULL OR c.expires_at<=now())`,
    [key]
  );
  await client.query(
    `UPDATE sender_controls SET state='READY',cooldown_until=NULL,reason=NULL,updated_at=now()
    WHERE sender_key=$1 AND state='COOLDOWN' AND cooldown_until<=now()`,
    [key]
  );
  await finishCampaigns(client, key);
}

async function claimNext(
  client: PoolClient,
  key: string,
  liveEnabled: boolean
): Promise<Claim | null> {
  await client.query("BEGIN");
  try {
    const candidate = await client.query(
      `SELECT d.id,d.campaign_id,d.recipient,d.random_id,c.owner_id,c.kind,c.sender_key,c.message,c.parse_mode,c.delay_seconds,c.is_dry_run,c.sender_fingerprint
      FROM delivery_campaigns c JOIN deliveries d ON d.campaign_id=c.id JOIN sender_controls s ON s.sender_key=c.sender_key
      WHERE c.sender_key=$1 AND c.status IN ('queued','running') AND c.cancel_requested_at IS NULL
        AND c.scheduled_at<=now() AND (c.expires_at IS NULL OR c.expires_at>now()) AND d.state='pending' AND d.available_at<=now()
        AND (c.is_dry_run OR ($2 AND s.state='READY' AND s.next_send_at<=now() AND (s.cooldown_until IS NULL OR s.cooldown_until<=now())))
      ORDER BY d.available_at,c.id,d.id FOR UPDATE OF c,d LIMIT 1`,
      [key, liveEnabled]
    );
    if (!candidate.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const row = candidate.rows[0] as Omit<Claim, "attempt_id">;
    const attemptId = randomUUID();
    await client.query(
      `UPDATE deliveries SET state='inflight',attempt_id=$2,updated_at=now() WHERE id=$1 AND state='pending'`,
      [row.id, attemptId]
    );
    await client.query(
      `INSERT INTO delivery_attempts(id,delivery_id,state) VALUES($1,$2,'inflight')`,
      [attemptId, row.id]
    );
    await client.query(
      `UPDATE delivery_campaigns SET status='running' WHERE id=$1`,
      [row.campaign_id]
    );
    await client.query("COMMIT");
    return { ...row, attempt_id: attemptId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function finishClaim(
  client: PoolClient,
  claim: Claim,
  state: string,
  code: string | null,
  messageId?: string
) {
  const result = await client.query(
    `UPDATE deliveries SET state=$3,last_error=$4,message_id=$5,updated_at=now()
    WHERE id=$1 AND attempt_id=$2 AND state='inflight' RETURNING id`,
    [claim.id, claim.attempt_id, state, code, messageId ?? null]
  );
  if (!result.rowCount) throw new Error("DELIVERY_CLAIM_LOST");
  await client.query(
    `UPDATE delivery_attempts SET state=$2,error_code=$3,completed_at=now() WHERE id=$1 AND state='inflight'`,
    [claim.attempt_id, state, code]
  );
}

async function processClaim(
  client: PoolClient,
  claim: Claim,
  options: WorkerOptions,
  connectionLost: () => boolean
) {
  const frequency = nonnegativeSetting(
    options.contactMinIntervalSeconds ??
      process.env.CONTACT_MIN_INTERVAL_SECONDS,
    86400
  );
  // The post-claim check sees cancellations/opt-outs that arrived while claiming. An active
  // dispatch is explicitly visible as inflight; cancel reports stopping until this function settles.
  const fresh = await client.query(
    `SELECT c.cancel_requested_at,c.expires_at,p.allowed,p.suppressed_at,cc.next_send_at
    FROM delivery_campaigns c LEFT JOIN contact_permissions p ON p.owner_id=c.owner_id AND p.kind=c.kind AND p.recipient=$2
    LEFT JOIN contact_delivery_controls cc ON cc.sender_key=c.sender_key AND cc.recipient=$2 WHERE c.id=$1`,
    [claim.campaign_id, claim.recipient]
  );
  const guard = fresh.rows[0];
  if (!guard || guard.cancel_requested_at) {
    await finishClaim(client, claim, "cancelled", "OWNER_CANCELLED");
    return;
  }
  if (guard.expires_at && new Date(guard.expires_at) <= new Date()) {
    await finishClaim(client, claim, "expired", "CAMPAIGN_EXPIRED");
    return;
  }
  if (!guard.allowed || guard.suppressed_at) {
    await finishClaim(
      client,
      claim,
      "suppressed",
      guard.suppressed_at ? "CONTACT_SUPPRESSED" : "CONTACT_PERMISSION_MISSING"
    );
    return;
  }
  if (
    !claim.is_dry_run &&
    guard.next_send_at &&
    new Date(guard.next_send_at) > new Date()
  ) {
    await client.query(
      `UPDATE deliveries SET state='pending',available_at=$3,last_error='CONTACT_FREQUENCY_WAIT',updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state='inflight'`,
      [claim.id, claim.attempt_id, guard.next_send_at]
    );
    await client.query(
      `UPDATE delivery_attempts SET state='deferred',error_code='CONTACT_FREQUENCY_WAIT',completed_at=now() WHERE id=$1`,
      [claim.attempt_id]
    );
    return;
  }
  if (claim.is_dry_run) {
    await finishClaim(client, claim, "dry_run", null);
    return;
  }
  // Defense in depth if callers bypass the scheduler. Paid broadcast flags are not supported here.
  if (!(options.liveSendEnabled ?? process.env.LIVE_SEND_ENABLED === "true")) {
    await finishClaim(client, claim, "failed", "LIVE_SEND_DISABLED");
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("DISPATCH_TIMEOUT")),
    Math.max(100, nonnegativeSetting(options.dispatchTimeoutMs, 30000))
  );
  const abortOnConnectionLoss = () =>
    controller.abort(new Error("DATABASE_LOCK_LOST"));
  client.on("error", abortOnConnectionLoss);
  let result: { messageId?: string } | undefined;
  let error: unknown;
  try {
    if (connectionLost()) throw new Error("DATABASE_LOCK_LOST");
    result = await options.transport.send({
      ownerId: Number(claim.owner_id),
      kind: claim.kind,
      recipient: claim.recipient,
      message: claim.message,
      parseMode: claim.parse_mode,
      deliveryId: String(claim.id),
      randomId: claim.random_id,
      signal: controller.signal,
      senderFingerprint: claim.sender_fingerprint ?? undefined,
    });
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timeout);
    client.removeListener("error", abortOnConnectionLoss);
  }

  // Persist outcome, sender pacing and contact frequency together. If this transaction fails
  // after Telegram accepted the request, recovery records unknown; it never resends blindly.
  await client.query("BEGIN");
  try {
    const interval = Math.max(
      claim.kind === "bot" ? 1 : 3,
      Number(claim.delay_seconds)
    );
    await client.query(
      `UPDATE sender_controls SET next_send_at=GREATEST(next_send_at,now()+$2*interval '1 second'),updated_at=now() WHERE sender_key=$1`,
      [claim.sender_key, interval]
    );
    if (result) {
      await finishClaim(client, claim, "accepted", null, result.messageId);
      await client.query(
        `INSERT INTO contact_delivery_controls(sender_key,recipient,next_send_at,last_accepted_at)
        VALUES($1,$2,now()+$3*interval '1 second',now()) ON CONFLICT(sender_key,recipient) DO UPDATE SET
        next_send_at=GREATEST(contact_delivery_controls.next_send_at,EXCLUDED.next_send_at),last_accepted_at=now()`,
        [claim.sender_key, claim.recipient, frequency]
      );
    } else if (error instanceof DeliveryError) {
      const code = safeCode(error.code);
      const wait = Math.max(1, nonnegativeSetting(error.retryAfterSeconds, 60));
      if (
        error.category === "cooldown" ||
        error.category === "slowmode" ||
        error.category === "transient"
      ) {
        const attempts = await client.query(
          "SELECT COUNT(*)::int AS count FROM delivery_attempts WHERE delivery_id=$1",
          [claim.id]
        );
        // Confirmed-unsent transient failures have a retry cap. Server-mandated waits are retained.
        if (error.category === "transient" && attempts.rows[0].count >= 5) {
          await finishClaim(client, claim, "failed", "UNSENT_RETRY_EXHAUSTED");
        } else {
          await client.query(
            `UPDATE deliveries SET state='pending',available_at=now()+$3*interval '1 second',last_error=$4,updated_at=now()
            WHERE id=$1 AND attempt_id=$2 AND state='inflight'`,
            [claim.id, claim.attempt_id, wait, code]
          );
          await client.query(
            `UPDATE delivery_attempts SET state='deferred',error_code=$2,completed_at=now() WHERE id=$1`,
            [claim.attempt_id, code]
          );
          if (error.category === "cooldown") {
            await client.query(
              `UPDATE sender_controls SET state='COOLDOWN',cooldown_until=GREATEST(COALESCE(cooldown_until,now()),now()+$2*interval '1 second'),reason=$3,updated_at=now() WHERE sender_key=$1`,
              [claim.sender_key, wait, code]
            );
          } else if (error.category === "slowmode") {
            await client.query(
              `INSERT INTO contact_delivery_controls(sender_key,recipient,next_send_at) VALUES($1,$2,now()+$3*interval '1 second')
              ON CONFLICT(sender_key,recipient) DO UPDATE SET next_send_at=GREATEST(contact_delivery_controls.next_send_at,EXCLUDED.next_send_at)`,
              [claim.sender_key, claim.recipient, wait]
            );
          }
        }
      } else if (error.category === "restricted" || error.category === "auth") {
        // Telegram confirmed rejection, so retain this recipient for an explicit sender review.
        await client.query(
          `UPDATE deliveries SET state='pending',last_error=$3,updated_at=now() WHERE id=$1 AND attempt_id=$2 AND state='inflight'`,
          [claim.id, claim.attempt_id, code]
        );
        await client.query(
          `UPDATE delivery_attempts SET state='rejected',error_code=$2,completed_at=now() WHERE id=$1`,
          [claim.attempt_id, code]
        );
        await client.query(
          `UPDATE sender_controls SET state=$2,reason=$3,updated_at=now() WHERE sender_key=$1`,
          [
            claim.sender_key,
            error.category === "auth" ? "AUTH_REQUIRED" : "REVIEW_REQUIRED",
            code,
          ]
        );
      } else {
        await finishClaim(client, claim, "failed", code);
        if (error.category === "recipient") {
          await client.query(
            `UPDATE contact_permissions SET allowed=false,suppressed_at=COALESCE(suppressed_at,now()),source=$4,updated_at=now() WHERE owner_id=$1 AND kind=$2 AND recipient=$3`,
            [claim.owner_id, claim.kind, claim.recipient, `telegram:${code}`]
          );
        } else if (error.category === "content") {
          await client.query(
            `UPDATE deliveries SET state='cancelled',last_error='INVALID_CAMPAIGN_CONTENT',updated_at=now() WHERE campaign_id=$1 AND state='pending'`,
            [claim.campaign_id]
          );
          await client.query(
            `UPDATE delivery_campaigns SET status='failed',completed_at=now() WHERE id=$1`,
            [claim.campaign_id]
          );
        }
      }
    } else {
      await finishClaim(
        client,
        claim,
        "unknown",
        controller.signal.aborted
          ? "DISPATCH_TIMEOUT_OR_LOCK_LOST"
          : "DELIVERY_RESULT_UNKNOWN"
      );
      // Unknown also reserves the contact-frequency window: a second campaign must not bypass uncertainty.
      await client.query(
        `INSERT INTO contact_delivery_controls(sender_key,recipient,next_send_at)
        VALUES($1,$2,now()+$3*interval '1 second') ON CONFLICT(sender_key,recipient) DO UPDATE SET next_send_at=GREATEST(contact_delivery_controls.next_send_at,EXCLUDED.next_send_at)`,
        [claim.sender_key, claim.recipient, frequency]
      );
    }
    await client.query("COMMIT");
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => {});
    throw caught;
  }
}

/** Runs at most one delivery. Session advisory locks serialize each sender across all processes.
 * A killed/aborted connection never causes a recovered in-flight delivery to be resent.
 */
export async function runWorkerOnce(
  options: WorkerOptions
): Promise<{ worked: boolean; deliveryId?: string }> {
  const pool = options.pool ?? getPool();
  const liveEnabled =
    options.liveSendEnabled ?? process.env.LIVE_SEND_ENABLED === "true";
  const candidates =
    await pool.query(`SELECT s.sender_key FROM sender_controls s
    WHERE EXISTS(SELECT 1 FROM delivery_campaigns c WHERE c.sender_key=s.sender_key AND
      (c.status IN ('queued','running','stopping') OR EXISTS(SELECT 1 FROM deliveries d WHERE d.campaign_id=c.id AND d.state='inflight')))
    ORDER BY s.next_send_at,s.updated_at,s.sender_key LIMIT 100`);
  for (const { sender_key: key } of candidates.rows) {
    const client = await pool.connect();
    let locked = false;
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on("error", onError);
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [`tg-sender:${key}`]
      );
      locked = result.rows[0].locked === true;
      if (!locked) continue;
      await housekeeping(
        client,
        key,
        nonnegativeSetting(
          options.contactMinIntervalSeconds ??
            process.env.CONTACT_MIN_INTERVAL_SECONDS,
          86400
        )
      );
      const claim = await claimNext(client, key, liveEnabled);
      if (!claim) continue;
      await processClaim(client, claim, options, () => broken);
      await finishCampaigns(client, key);
      return { worked: true, deliveryId: String(claim.id) };
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      if (locked && !broken)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `tg-sender:${key}`,
          ])
          .catch(() => {
            broken = true;
          });
      client.removeListener("error", onError);
      client.release(broken);
    }
  }
  return { worked: false };
}
