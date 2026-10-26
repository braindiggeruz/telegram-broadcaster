import { z } from "zod";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
import { getSenderStatus, getWorkerStatus, resumeSender } from "./delivery";
import { getMaintenanceStatus } from "./maintenance";
export async function readiness() {
  try {
    await getPool().query("SELECT 1 FROM app_migrations LIMIT 1");
    const workers = await getWorkerStatus();
    const latest = workers.find(
      w =>
        w.healthy &&
        !w.last_error &&
        w.last_success_at &&
        Date.now() - w.last_success_at.getTime() <= 90_000
    );
    return {
      ready: !!latest,
      database: true,
      liveSendEnabled: process.env.LIVE_SEND_ENABLED === "true",
      worker: {
        running: !!latest,
        lastHeartbeatAt:
          latest?.last_seen_at?.toISOString() ??
          workers[0]?.last_seen_at?.toISOString() ??
          null,
      },
    };
  } catch {
    return {
      ready: false,
      database: false,
      liveSendEnabled: false,
      worker: { running: false, lastHeartbeatAt: null },
    };
  }
}
export const operationsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const status = await readiness();
    if (!status.database)
      return {
        ...status,
        senders: [],
        exceptions: [
          {
            id: "database",
            title: "База недоступна",
            detail: "Отправки приостановлены",
            createdAt: new Date().toISOString(),
          },
        ],
      };
    const senders = await Promise.all(
      (["bot", "mtproto"] as const).map(async transport => ({
        transport,
        ...(await getSenderStatus(ctx.user.id, transport)),
      }))
    );
    const unknown = await getPool().query(
      "SELECT count(*)::int AS count FROM deliveries d JOIN delivery_campaigns c ON c.id=d.campaign_id WHERE c.owner_id=$1 AND d.state='unknown'",
      [ctx.user.id]
    );
    const exceptions: {
      id: string;
      title: string;
      detail: string;
      createdAt: string;
    }[] = senders
      .filter(s =>
        ["REVIEW_REQUIRED", "AUTH_REQUIRED", "DISABLED"].includes(s.state)
      )
      .map(s => ({
        id: s.transport,
        title: `${s.transport}: требуется действие`,
        detail: s.reason ?? s.state,
        createdAt: new Date().toISOString(),
      }));
    if (!status.ready)
      exceptions.push({
        id: "worker",
        title: "Обработчик очереди требует внимания",
        detail:
          "Нет свежего успешного цикла обработки. Проверьте журнал сервиса.",
        createdAt: new Date().toISOString(),
      });
    if (unknown.rows[0].count)
      exceptions.push({
        id: "unknown",
        title: "Есть отправки с неизвестным результатом",
        detail: `${unknown.rows[0].count}. Автоматический повтор выключен.`,
        createdAt: new Date().toISOString(),
      });
    const events = await getPool().query(
      "SELECT count(*)::int AS count FROM automation_events WHERE owner_id=$1 AND status IN ('blocked','review_required')",
      [ctx.user.id]
    );
    if (events.rows[0].count)
      exceptions.push({
        id: "automation",
        title: "Сценарий требует проверки",
        detail: `Событий: ${events.rows[0].count}. Откройте журнал автопилота.`,
        createdAt: new Date().toISOString(),
      });
    const maintenance = await getMaintenanceStatus();
    for (const job of maintenance)
      if (job.last_error || job.last_rehearsal_error)
        exceptions.push({
          id: `maintenance:${job.name}`,
          title: "Резервная копия требует внимания",
          detail: job.last_error ?? job.last_rehearsal_error,
          createdAt: new Date().toISOString(),
        });
    return { ...status, senders, exceptions, maintenance };
  }),
  resumeSender: protectedProcedure
    .input(
      z.object({
        transport: z.enum(["bot", "mtproto"]),
        confirmed: z.literal(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await resumeSender(ctx.user.id, input.transport);
      await getPool().query(
        "INSERT INTO audit_events(owner_id,action,target) VALUES($1,$2,$3)",
        [ctx.user.id, "sender.reviewed", input.transport]
      );
      return result;
    }),
});
