import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getPool } from "./connection";
import { getRecipientList } from "./db";
import { createCampaign, launchCampaign } from "./campaigns";
import { senderFingerprint } from "./senderIdentity";
import { encryptSecret, decryptSecret } from "./security/secrets";
const id = z.number().int().positive();
const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.enum(["bot", "mtproto"]),
  listId: id,
  message: z.string().trim().min(1).max(4096),
  parseMode: z.enum(["HTML", "Markdown", "MarkdownV2", "None"]),
  trigger: z.enum(["schedule", "webhook"]),
  intervalMinutes: z.number().int().min(5).max(525600).optional(),
  delaySeconds: z.number().min(1).max(86400).default(3),
  isDryRun: z.boolean().default(true),
  maxRunsPerDay: z.number().int().min(1).max(288).default(24),
  approved: z.literal(true),
  requestKey: z.string().min(1).max(128).optional(),
  useCurrentAudience: z.boolean().default(false),
});
function ruleDto(r: any) {
  return {
    id: r.id as number,
    useCurrentAudience: !!r.use_current_audience,
    name: r.name as string,
    transport: r.transport as "bot" | "mtproto",
    listId: r.list_id as number,
    message: r.message as string,
    parseMode: r.parse_mode as "HTML" | "Markdown" | "MarkdownV2" | "None",
    trigger: r.trigger as "schedule" | "webhook",
    intervalMinutes: r.interval_minutes as number | null,
    delaySeconds: r.delay_seconds as number,
    isDryRun: r.is_dry_run as boolean,
    maxRunsPerDay: r.max_runs_per_day as number,
    enabled: r.enabled as boolean,
    nextRunAt: r.next_run_at as Date | null,
    lastRunAt: r.last_run_at as Date | null,
  };
}
const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export const automationRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (
      await getPool().query(
        "SELECT * FROM automation_rules WHERE owner_id=$1 AND NOT archived ORDER BY id DESC",
        [ctx.user.id]
      )
    ).rows.map(ruleDto)
  ),
  create: protectedProcedure
    .input(ruleInput)
    .mutation(async ({ ctx, input }) => {
      if (input.trigger === "schedule" && !input.intervalMinutes)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Укажите интервал расписания",
        });
      if (!input.isDryRun && process.env.LIVE_SEND_ENABLED !== "true")
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Реальные отправки выключены",
        });
      const list = await getRecipientList(input.listId, ctx.user.id);
      if (!list)
        throw new TRPCError({ code: "NOT_FOUND", message: "Список не найден" });
      const fingerprint = input.isDryRun
        ? null
        : await senderFingerprint(ctx.user.id, input.transport);
      const requestKey = input.requestKey ?? randomUUID();
      const requestHash = digest(
        JSON.stringify({
          ...input,
          requestKey: undefined,
          recipients: JSON.parse(list.chatIds),
          fingerprint,
        })
      );
      const secretContext = `automation:${ctx.user.id}:${requestKey}`;
      const tx = await getPool().connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `automation:${ctx.user.id}:${requestKey}`,
        ]);
        const prior = await tx.query(
          "SELECT * FROM automation_rules WHERE owner_id=$1 AND request_key=$2",
          [ctx.user.id, requestKey]
        );
        if (prior.rowCount) {
          const row = prior.rows[0];
          if (row.request_hash !== requestHash)
            throw new TRPCError({
              code: "CONFLICT",
              message: "Этот ключ уже относится к другому сценарию",
            });
          await tx.query("COMMIT");
          return {
            ...ruleDto(row),
            webhookSecret: row.webhook_secret
              ? decryptSecret(row.webhook_secret, secretContext)
              : null,
            webhookPath: row.webhook_hash
              ? `/api/automation/${row.id}/events`
              : null,
          };
        }
        const secret =
          input.trigger === "webhook"
            ? randomBytes(32).toString("base64url")
            : null;
        const r = await tx.query(
          `INSERT INTO automation_rules(owner_id,name,transport,list_id,recipients,message,parse_mode,delay_seconds,is_dry_run,trigger,interval_minutes,max_runs_per_day,webhook_hash,next_run_at,sender_fingerprint,request_key,request_hash,webhook_secret)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::integer,$12,$13,CASE WHEN $10='schedule' THEN now()+$11::integer*interval '1 minute' ELSE NULL END,$14,$15,$16,$17) RETURNING *`,
          [
            ctx.user.id,
            input.name,
            input.transport,
            input.listId,
            list.chatIds,
            input.message,
            input.parseMode,
            Math.max(input.transport === "bot" ? 1 : 3, input.delaySeconds),
            input.isDryRun,
            input.trigger,
            input.intervalMinutes ?? null,
            input.maxRunsPerDay,
            secret ? digest(secret) : null,
            fingerprint,
            requestKey,
            requestHash,
            secret ? encryptSecret(secret, secretContext) : null,
          ]
        );
        await tx.query(
          "UPDATE automation_rules SET use_current_audience=$2 WHERE id=$1",
          [r.rows[0].id, input.useCurrentAudience]
        );
        r.rows[0].use_current_audience = input.useCurrentAudience;
        await tx.query(
          "INSERT INTO audit_events(owner_id,action,target) VALUES($1,$2,$3)",
          [ctx.user.id, "automation.approved", String(r.rows[0].id)]
        );
        await tx.query("COMMIT");
        return {
          ...ruleDto(r.rows[0]),
          webhookSecret: secret,
          webhookPath: secret ? `/api/automation/${r.rows[0].id}/events` : null,
        };
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
    }),
  updateEnabled: protectedProcedure
    .input(z.object({ id, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const r = await getPool().query(
        `UPDATE automation_rules SET enabled=$3,next_run_at=CASE WHEN $3 AND trigger='schedule' THEN now()+(interval_minutes::text||' minutes')::interval ELSE next_run_at END WHERE id=$1 AND owner_id=$2 AND NOT archived RETURNING *`,
        [input.id, ctx.user.id, input.enabled]
      );
      if (!r.rowCount)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Сценарий не найден",
        });
      return ruleDto(r.rows[0]);
    }),
  remove: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      await getPool().query(
        "UPDATE automation_rules SET enabled=false,archived=true WHERE id=$1 AND owner_id=$2",
        [input.id, ctx.user.id]
      );
      return { success: true };
    }),
  events: protectedProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .optional()
    )
    .query(
      async ({ ctx, input }) =>
        (
          await getPool().query(
            'SELECT id,rule_id AS "ruleId",status,created_at AS "createdAt",detail,broadcast_id AS "broadcastId" FROM automation_events WHERE owner_id=$1 ORDER BY id DESC LIMIT $2',
            [ctx.user.id, input?.limit ?? 50]
          )
        ).rows as {
          id: string;
          ruleId: number;
          status: string;
          createdAt: Date;
          detail: string | null;
          broadcastId: number | null;
        }[]
    ),
});

async function insertEvent(tx: PoolClient, rule: any, eventKey: string) {
  const existing = await tx.query(
    "SELECT id,status FROM automation_events WHERE rule_id=$1 AND event_key=$2",
    [rule.id, eventKey]
  );
  if (existing.rowCount)
    return { id: String(existing.rows[0].id), duplicate: true };
  const count = await tx.query(
    "SELECT count(*)::int AS count FROM automation_events WHERE rule_id=$1 AND created_at>now()-interval '24 hours'",
    [rule.id]
  );
  if (count.rows[0].count >= rule.max_runs_per_day) return null;
  const inserted = await tx.query(
    "INSERT INTO automation_events(rule_id,owner_id,event_key) VALUES($1,$2,$3) RETURNING id",
    [rule.id, rule.owner_id, eventKey]
  );
  return { id: String(inserted.rows[0].id), duplicate: false };
}

export function registerAutomationWebhook(app: Express) {
  app.post("/api/automation/:id/events", async (req, res) => {
    const parsed = z
      .object({
        eventId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_.:-]+$/),
      })
      .strict()
      .safeParse(req.body);
    const ruleId = Number(req.params.id);
    if (!Number.isSafeInteger(ruleId) || ruleId < 1 || !parsed.success) {
      res.status(400).json({ error: "INVALID_EVENT" });
      return;
    }
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{40,128})$/
    )?.[1];
    if (!token) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    let tx: PoolClient | undefined;
    try {
      tx = await getPool().connect();
      await tx.query("BEGIN");
      const r = await tx.query(
        "SELECT * FROM automation_rules WHERE id=$1 AND trigger='webhook' FOR UPDATE",
        [ruleId]
      );
      const rule = r.rows[0];
      if (
        !rule?.webhook_hash ||
        !timingSafeEqual(
          Buffer.from(digest(token), "hex"),
          Buffer.from(rule.webhook_hash, "hex")
        )
      ) {
        await tx.query("ROLLBACK");
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      if (!rule.enabled || rule.archived) {
        await tx.query("ROLLBACK");
        res.status(409).json({ error: "RULE_DISABLED" });
        return;
      }
      const result = await insertEvent(
        tx,
        rule,
        `webhook:${parsed.data.eventId}`
      );
      await tx.query("COMMIT");
      res
        .status(result ? 202 : 429)
        .json(result ?? { error: "DAILY_EVENT_LIMIT" });
    } catch {
      await tx?.query("ROLLBACK").catch(() => {});
      res.status(503).json({ error: "EVENT_UNAVAILABLE" });
    } finally {
      tx?.release();
    }
  });
}

export async function tickAutomations() {
  const pool = getPool(),
    tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const due = await tx.query(
      "SELECT * FROM automation_rules WHERE enabled AND NOT archived AND trigger='schedule' AND next_run_at<=now() ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED"
    );
    for (const rule of due.rows) {
      await insertEvent(
        tx,
        rule,
        `schedule:${new Date(rule.next_run_at).toISOString()}`
      );
      await tx.query(
        "UPDATE automation_rules SET next_run_at=now()+(interval_minutes::text||' minutes')::interval WHERE id=$1",
        [rule.id]
      );
    }
    await tx.query("COMMIT");
    for (let i = 0; i < 5; i++) {
      await tx.query("BEGIN");
      const pending = await tx.query(
        "SELECT * FROM automation_events WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"
      );
      if (!pending.rowCount) {
        await tx.query("COMMIT");
        break;
      }
      const event = pending.rows[0];
      const r = await tx.query(
        "SELECT * FROM automation_rules WHERE id=$1 FOR UPDATE",
        [event.rule_id]
      );
      const rule = r.rows[0];
      if (!rule.enabled || rule.archived) {
        await tx.query(
          "UPDATE automation_events SET status='cancelled',detail='RULE_DISABLED' WHERE id=$1",
          [event.id]
        );
        await tx.query("COMMIT");
        continue;
      }
      if (Date.now() - new Date(event.created_at).getTime() > 86400000) {
        await tx.query(
          "UPDATE automation_events SET status='expired',detail='EVENT_EXPIRED' WHERE id=$1",
          [event.id]
        );
        await tx.query("COMMIT");
        continue;
      }
      if (!rule.is_dry_run && process.env.LIVE_SEND_ENABLED !== "true") {
        await tx.query(
          "UPDATE automation_events SET status='blocked',detail='LIVE_SEND_DISABLED' WHERE id=$1",
          [event.id]
        );
        await tx.query("COMMIT");
        continue;
      }
      try {
        if (
          !rule.is_dry_run &&
          rule.sender_fingerprint !==
            (await senderFingerprint(rule.owner_id, rule.transport))
        )
          throw new Error("SENDER_CHANGED");
        let audience = rule.recipients;
        if (rule.use_current_audience) {
          const current = await getRecipientList(rule.list_id, rule.owner_id);
          if (!current) throw new Error("AUDIENCE_UNAVAILABLE");
          audience = JSON.parse(current.chatIds);
        }
        const bc = await createCampaign(
          rule.owner_id,
          rule.transport,
          {
            name: rule.name,
            message: rule.message,
            parseMode: rule.parse_mode,
            delaySeconds: rule.delay_seconds,
            isDryRun: rule.is_dry_run,
            recipientListId: rule.list_id,
            requestKey: `automation:${event.id}`,
            approved: true,
          },
          audience,
          rule.sender_fingerprint
        );
        await launchCampaign(rule.owner_id, rule.transport, bc.id);
        await tx.query(
          "UPDATE automation_events SET status='enqueued',broadcast_id=$2,detail=NULL WHERE id=$1",
          [event.id, bc.id]
        );
        await tx.query(
          "UPDATE automation_rules SET last_run_at=now() WHERE id=$1",
          [rule.id]
        );
      } catch {
        await tx.query(
          "UPDATE automation_events SET status='review_required',detail='EVENT_REQUIRES_REVIEW' WHERE id=$1",
          [event.id]
        );
        await tx.query(
          "UPDATE automation_rules SET enabled=false WHERE id=$1",
          [rule.id]
        );
      }
      await tx.query("COMMIT");
    }
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
