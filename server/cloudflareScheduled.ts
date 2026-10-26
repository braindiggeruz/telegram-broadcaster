import { getPool, runWithDatabaseScope } from "./connection";
import { tickAutomations } from "./automation";
import {
  recordWorkerHeartbeat,
  recordWorkerSuccess,
  runWorkerOnce,
} from "./delivery";
import { telegramTransport } from "./telegramTransport";

const WORKER_ID = "cloudflare-cron";

interface BatchWork {
  dispatch: () => Promise<{ worked: boolean }>;
  nextDelay: () => Promise<number | null>;
  heartbeat: () => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  deadline: number;
  maxDeliveries?: number;
}

/** Stop between attempts. Never abandon an in-flight send merely to meet a batch budget. */
export async function runBoundedDeliveryBatch(work: BatchWork) {
  const now = work.now ?? Date.now;
  const sleep =
    work.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let completed = 0;
  let lastHeartbeat = now();
  while (now() < work.deadline && completed < (work.maxDeliveries ?? 30)) {
    const result = await work.dispatch();
    if (result.worked) completed++;
    else {
      const delay = await work.nextDelay();
      // A distant schedule should be handled by a later Cron, not a sleeping invocation.
      if (delay === null || delay > 10_000) break;
      const wait = Math.max(1000, delay);
      if (now() + wait >= work.deadline) break;
      await sleep(wait);
    }
    if (now() - lastHeartbeat >= 5000) {
      await work.heartbeat();
      lastHeartbeat = now();
    }
  }
  return { completed };
}

/** All PG clients and Telegram sockets finish within this Cron invocation. */
export async function runScheduledBatch() {
  return runWithDatabaseScope(async () => {
    const pool = getPool();
    const liveSendEnabled = process.env.LIVE_SEND_ENABLED === "true";
    const deadline = Date.now() + 40_000;
    const heartbeat = () =>
      recordWorkerHeartbeat(pool, WORKER_ID, liveSendEnabled);
    try {
      await heartbeat();
      await tickAutomations();
      const result = await runBoundedDeliveryBatch({
        deadline,
        heartbeat,
        dispatch: () =>
          runWorkerOnce({
            pool,
            transport: telegramTransport,
            liveSendEnabled,
            workerId: WORKER_ID,
            dispatchTimeoutMs: 20_000,
          }),
        nextDelay: async () => {
          const next = await pool.query<{ delay: number | null }>(
            `SELECT EXTRACT(EPOCH FROM (min(CASE WHEN c.is_dry_run
                THEN GREATEST(c.scheduled_at,d.available_at)
                ELSE GREATEST(c.scheduled_at,d.available_at,s.next_send_at,s.cooldown_until)
              END)-now()))::double precision*1000 AS delay
             FROM delivery_campaigns c JOIN deliveries d ON d.campaign_id=c.id
             JOIN sender_controls s ON s.sender_key=c.sender_key
             WHERE c.status IN ('queued','running') AND d.state='pending'
               AND (c.expires_at IS NULL OR c.expires_at>now())
               AND (c.is_dry_run OR ($1 AND s.state IN ('READY','COOLDOWN')))`,
            [liveSendEnabled]
          );
          const delay = next.rows[0]?.delay;
          return typeof delay === "number" && Number.isFinite(delay)
            ? Math.max(0, delay)
            : null;
        },
      });
      await recordWorkerSuccess(pool, WORKER_ID, liveSendEnabled);
      return result;
    } catch {
      await recordWorkerHeartbeat(
        pool,
        WORKER_ID,
        liveSendEnabled,
        "CLOUD_WORKER_TICK_FAILED"
      ).catch(() => {});
      // The next Cron re-enters the durable engine; uncertain deliveries are never blindly resent.
      throw new Error("CLOUD_WORKER_TICK_FAILED");
    }
  });
}
