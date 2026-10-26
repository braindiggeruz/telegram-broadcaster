import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import { authRouter } from "./auth";
import * as db from "./db";
import { botSettingsDto, mtprotoSessionDto } from "./security/dto";
import { getPool } from "./connection";
import * as delivery from "./delivery";
import type { SenderKind } from "./delivery";
import { normalizeRecipient, parseRecipientCsv } from "../shared/recipients";
import { createCampaign, launchCampaign, enrichedCampaign } from "./campaigns";
import { draftRouter } from "./drafts";
import { automationRouter } from "./automation";
import { operationsRouter } from "./operations";
import { dashboard } from "./dashboard";
import { audienceSourceRouter } from "./audienceSource";
import { configureTelegramWebhook } from "./telegramWebhook";
import { telegramRequest } from "./telegramTransport";
import {
  sendPhoneCode,
  signInWithCode,
  signInWithPassword,
  logoutSession,
} from "./mtproto";
const idInput = z.object({ id: z.number().int().positive() });
const pageInput = idInput.extend({
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().nonnegative().default(0),
});
const createInput = z.object({
  name: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(4096),
  parseMode: z.enum(["HTML", "Markdown", "MarkdownV2", "None"]),
  delaySeconds: z.number().min(0.5).max(86400),
  isDryRun: z.boolean().default(true),
  recipientListId: z.number().int().positive(),
  requestKey: z.string().min(1).max(128).optional(),
  approved: z.boolean().default(false),
});
async function listCampaigns(ownerId: number, kind: SenderKind) {
  const list =
    kind === "bot"
      ? await db.getBroadcasts(ownerId)
      : await db.getMtprotoBroadcasts(ownerId);
  return Promise.all(
    list.map(async bc => (await enrichedCampaign(ownerId, kind, bc))!)
  );
}
async function getCampaign(ownerId: number, kind: SenderKind, id: number) {
  return enrichedCampaign(
    ownerId,
    kind,
    kind === "bot"
      ? await db.getBroadcast(id, ownerId)
      : await db.getMtprotoBroadcast(id, ownerId)
  );
}
async function progress(ownerId: number, kind: SenderKind, id: number) {
  const bc =
    kind === "bot"
      ? await db.getBroadcast(id, ownerId)
      : await db.getMtprotoBroadcast(id, ownerId);
  if (!bc) return null;
  return (
    (await delivery.getProgress(ownerId, kind, id)) ?? {
      sent: bc.sentCount,
      accepted: bc.sentCount,
      failed: bc.failedCount,
      total: bc.totalRecipients,
      status: bc.status,
      running: false,
      pending: bc.totalRecipients,
      unknown: 0,
      suppressed: 0,
      dryRun: 0,
      inflight: 0,
      cancelled: 0,
      expired: 0,
      isDryRun: bc.isDryRun,
      sender: null,
    }
  );
}
function campaignRouter(kind: SenderKind) {
  return {
    list: protectedProcedure.query(({ ctx }) =>
      listCampaigns(ctx.user.id, kind)
    ),
    get: protectedProcedure
      .input(idInput)
      .query(({ ctx, input }) => getCampaign(ctx.user.id, kind, input.id)),
    getProgress: protectedProcedure
      .input(idInput)
      .query(({ ctx, input }) => progress(ctx.user.id, kind, input.id)),
    getLogs: protectedProcedure.input(idInput).query(
      async ({ ctx, input }) =>
        (
          await delivery.getDeliveryLogs(ctx.user.id, kind, input.id, {
            limit: 500,
            offset: 0,
          })
        ).items
    ),
    getDeliveryPage: protectedProcedure
      .input(pageInput)
      .query(({ ctx, input }) =>
        delivery.getDeliveryLogs(ctx.user.id, kind, input.id, input)
      ),
    create: protectedProcedure
      .input(createInput)
      .mutation(({ ctx, input }) => createCampaign(ctx.user.id, kind, input)),
    launch: protectedProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        launchCampaign(ctx.user.id, kind, input.id)
      ),
    cancel: protectedProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        delivery.cancelCampaign(ctx.user.id, kind, input.id)
      ),
    resume: protectedProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        delivery.resumeCampaign(ctx.user.id, kind, input.id)
      ),
    resolveUnknown: protectedProcedure
      .input(
        idInput.extend({
          deliveryIds: z
            .array(z.string().regex(/^[1-9]\d*$/))
            .min(1)
            .max(500),
          resolution: z.enum(["accepted", "cancelled"]),
          evidence: z.string().min(10).max(2000),
        })
      )
      .mutation(({ ctx, input }) =>
        delivery.resolveUnknown({
          ownerId: ctx.user.id,
          kind,
          broadcastId: input.id,
          deliveryIds: input.deliveryIds,
          resolution: input.resolution,
          evidence: input.evidence,
        })
      ),
  };
}
const botRouter = router({
  configureWebhook: protectedProcedure.mutation(({ ctx }) =>
    configureTelegramWebhook(ctx.user.id)
  ),
  get: protectedProcedure.query(async ({ ctx }) =>
    botSettingsDto(await db.getBotSettings(ctx.user.id))
  ),
  validate: protectedProcedure
    .input(
      z.object({ token: z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/) })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await telegramRequest(input.token, "getMe");
      if (!result.ok || !result.result)
        return {
          valid: false,
          error: "Telegram не подтвердил токен. Проверьте подключение и токен.",
        };
      const bot = result.result as { first_name: string; username: string };
      await db.upsertBotSettings(ctx.user.id, {
        botToken: input.token,
        botName: bot.first_name,
        botUsername: bot.username,
        isValid: true,
      });
      return {
        valid: true,
        botName: bot.first_name,
        botUsername: bot.username,
      };
    }),
});
const recipientsRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    db.getRecipientLists(ctx.user.id)
  ),
  get: protectedProcedure
    .input(idInput)
    .query(({ ctx, input }) => db.getRecipientList(input.id, ctx.user.id)),
  upload: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(256),
        content: z.string().max(2000000),
        fileType: z.enum(["json", "csv"]),
        recipientType: z
          .enum(["chat_id", "username", "phone", "auto"])
          .default("auto"),
        consentSource: z.string().trim().min(3).max(256),
        consentConfirmed: z.literal(true),
        permissionTransport: z.enum(["bot", "mtproto"]).default("bot"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let raw: unknown[];
      try {
        if (input.fileType === "json") {
          const value = JSON.parse(input.content);
          raw = Array.isArray(value)
            ? value
            : (value.users ?? value.chat_ids ?? value.phones);
        } else raw = parseRecipientCsv(input.content).map(row => row[0]);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Некорректный файл",
        });
      }
      if (!Array.isArray(raw) || !raw.length || raw.length > 50000)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Допустимо от 1 до 50 000 строк",
        });
      const normalized = raw.map(v =>
        normalizeRecipient(v, input.recipientType)
      );
      if (normalized.some(v => !v))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "В списке есть неоднозначные значения. Исправьте их в предпросмотре.",
        });
      const recipients = [...new Set(normalized.map(v => v!.value))];
      const list = await db.createRecipientList({
        userId: ctx.user.id,
        name: input.name,
        chatIds: JSON.stringify(recipients),
        totalCount: recipients.length,
        fileType: input.fileType,
      });
      // Re-import never removes a suppression. Keep separate transport permissions.
      const tx = await getPool().connect();
      try {
        await tx.query("BEGIN");
        const canonical = recipients.map(delivery.normalizeRecipient);
        for (const kind of [input.permissionTransport]) {
          const eligible =
            kind === "bot"
              ? canonical.filter(v => !v.startsWith("phone:"))
              : canonical;
          await tx.query(
            `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source) SELECT $1,$2,recipient,true,$4 FROM unnest($3::text[]) AS recipient ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET source=CASE WHEN contact_permissions.suppressed_at IS NULL THEN excluded.source ELSE contact_permissions.source END,allowed=CASE WHEN contact_permissions.suppressed_at IS NULL THEN true ELSE false END,updated_at=now()`,
            [ctx.user.id, kind, eligible, input.consentSource]
          );
        }
        await tx.query(
          "INSERT INTO audit_events(owner_id,action,target,detail) VALUES($1,$2,$3,$4)",
          [
            ctx.user.id,
            "audience.imported",
            String(list.id),
            JSON.stringify({
              count: recipients.length,
              source: input.consentSource,
            }),
          ]
        );
        await tx.query("COMMIT");
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
      return list;
    }),
  delete: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    await db.deleteRecipientList(input.id, ctx.user.id);
    return { success: true };
  }),
  setPermission: protectedProcedure
    .input(
      z.object({
        transport: z.enum(["bot", "mtproto"]),
        recipient: z.string().min(1).max(128),
        allowed: z.boolean(),
        source: z.string().min(3).max(256),
        explicitResubscribe: z.boolean().default(false),
      })
    )
    .mutation(({ ctx, input }) =>
      delivery.setContactPermission({
        ownerId: ctx.user.id,
        kind: input.transport,
        recipient: input.recipient,
        allowed: input.allowed,
        source: input.source,
        explicitResubscribe: input.explicitResubscribe,
      })
    ),
  permissions: protectedProcedure
    .input(
      z.object({
        transport: z.enum(["bot", "mtproto"]),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().nonnegative().default(0),
      })
    )
    .query(({ ctx, input }) =>
      delivery.listContactPermissions(ctx.user.id, input.transport, input)
    ),
});
const mt = campaignRouter("mtproto");
const mtprotoRouter = router({
  getSession: protectedProcedure.query(async ({ ctx }) =>
    mtprotoSessionDto(await db.getMtprotoSession(ctx.user.id))
  ),
  sendCode: protectedProcedure
    .input(z.object({ phone: z.string().regex(/^\+[1-9]\d{6,14}$/) }))
    .mutation(async ({ ctx, input }) => {
      await sendPhoneCode(ctx.user.id, input.phone);
      return { sent: true };
    }),
  signIn: protectedProcedure
    .input(z.object({ code: z.string().regex(/^\d{4,8}$/) }))
    .mutation(async ({ ctx, input }) => {
      await signInWithCode(
        ctx.user.id,
        input.code,
        async (result, authClient) => {
          await db.upsertMtprotoSession(
            ctx.user.id,
            {
              phone: result.user.phone,
              firstName: result.user.firstName,
              lastName: result.user.lastName,
              username: result.user.username,
              telegramId: result.user.id,
              sessionString: result.sessionString,
              isActive: true,
            },
            authClient
          );
        }
      );
      return { success: true };
    }),
  signInPassword: protectedProcedure
    .input(z.object({ password: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => {
      await signInWithPassword(
        ctx.user.id,
        input.password,
        async (result, authClient) => {
          await db.upsertMtprotoSession(
            ctx.user.id,
            {
              phone: result.user.phone,
              firstName: result.user.firstName,
              lastName: result.user.lastName,
              username: result.user.username,
              telegramId: result.user.id,
              sessionString: result.sessionString,
              isActive: true,
            },
            authClient
          );
        }
      );
      return { success: true };
    }),
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await logoutSession(ctx.user.id);
    return { success: true };
  }),
  listBroadcasts: mt.list,
  getBroadcast: mt.get,
  getBroadcastLogs: mt.getLogs,
  getProgress: mt.getProgress,
  getDeliveryPage: mt.getDeliveryPage,
  createBroadcast: mt.create,
  launchBroadcast: mt.launch,
  cancelBroadcast: mt.cancel,
  resumeBroadcast: mt.resume,
  resolveUnknown: mt.resolveUnknown,
});
export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  bot: botRouter,
  recipients: recipientsRouter,
  broadcast: router(campaignRouter("bot")),
  mtproto: mtprotoRouter,
  draft: draftRouter,
  source: audienceSourceRouter,
  automation: automationRouter,
  operations: operationsRouter,
  stats: router({
    dashboard: protectedProcedure.query(({ ctx }) => dashboard(ctx.user.id)),
  }),
});
export type AppRouter = typeof appRouter;
