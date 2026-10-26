import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getPool } from "./connection";
import {
  recordWorkerHeartbeat,
  recordWorkerSuccess,
  runWorkerOnce,
} from "./delivery";
import { telegramTransport } from "./telegramTransport";
import { tickAutomations } from "./automation";
import { tickMaintenance } from "./maintenance";

const workerId = `worker-${randomUUID()}`;
const liveSendEnabled = process.env.LIVE_SEND_ENABLED === "true";
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

async function main() {
  const pool = getPool();
  let maintenanceTask: Promise<unknown> | undefined;
  const maintenanceAbort = new AbortController();
  const maintenance = setInterval(() => {
    if (!maintenanceTask) {
      maintenanceTask = tickMaintenance({ signal: maintenanceAbort.signal })
        .catch(() => {})
        .finally(() => {
          maintenanceTask = undefined;
        });
    }
  }, 60000);
  // Heartbeat is separate from dispatch, so a slow transport remains observable.
  const heartbeat = setInterval(() => {
    void recordWorkerHeartbeat(pool, workerId, liveSendEnabled).catch(() => {});
  }, 5000);
  try {
    while (!stopping) {
      try {
        await recordWorkerHeartbeat(pool, workerId, liveSendEnabled);
        await tickAutomations();
        const result = await runWorkerOnce({
          pool,
          transport: telegramTransport,
          liveSendEnabled,
          workerId,
        });
        await recordWorkerSuccess(pool, workerId, liveSendEnabled);
        if (!result.worked)
          await new Promise(resolve => setTimeout(resolve, 1000));
      } catch {
        // Never print raw transport/DB errors: they can contain tokens, session data, or connection URLs.
        console.error(
          "[worker] WORKER_TICK_FAILED; inspect protected operations status"
        );
        await recordWorkerHeartbeat(
          pool,
          workerId,
          liveSendEnabled,
          "WORKER_TICK_FAILED"
        ).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(maintenance);
    maintenanceAbort.abort();
    // Let maintenance persist its outcome and release its checked-out clients before ending the shared pool.
    await maintenanceTask;
    await pool
      .query("DELETE FROM delivery_worker_heartbeats WHERE worker_id=$1", [
        workerId,
      ])
      .catch(() => {});
    await pool.end();
  }
}

void main().catch(() => {
  console.error("[worker] WORKER_START_FAILED");
  process.exitCode = 1;
});
