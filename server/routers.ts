import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  getBotSettings, upsertBotSettings,
  getRecipientLists, getRecipientList, createRecipientList, deleteRecipientList,
  getBroadcasts, getBroadcast, createBroadcast, updateBroadcastStatus, updateBroadcastProgress,
  createBroadcastLog, getBroadcastLogs,
  getMtprotoSession, upsertMtprotoSession, deleteMtprotoSession,
  getMtprotoBroadcasts, getMtprotoBroadcast, createMtprotoBroadcast,
  updateMtprotoBroadcastStatus, updateMtprotoBroadcastProgress,
  createMtprotoBroadcastLog, getMtprotoBroadcastLogs,
  getDashboardStats,
} from "./db";
import https from "https";
import {
  sendPhoneCode, signInWithCode, signInWithPassword,
  getActiveClient, logoutSession, sendMessageToUser,
} from "./mtproto";

// ── Telegram API helper ────────────────────────────────────────────────────

async function telegramRequest(token: string, method: string, body?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data!) } : {},
      timeout: 10000,
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false, description: "Invalid JSON" }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, description: "Timeout" }); });
    if (data) req.write(data);
    req.end();
  });
}

// In-memory broadcast progress store (per broadcastId)
const broadcastProgress: Record<number, { sent: number; failed: number; total: number; status: string; running: boolean }> = {};

// In-memory MTProto broadcast progress store
const mtprotoProgress: Record<number, { sent: number; failed: number; total: number; status: string; running: boolean }> = {};

// ── Routers ────────────────────────────────────────────────────────────────

const botRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    return getBotSettings(ctx.user.id);
  }),

  validate: protectedProcedure
    .input(z.object({ token: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const res = await telegramRequest(input.token, "getMe");
      if (res.ok && res.result) {
        const bot = res.result as { first_name: string; username: string };
        await upsertBotSettings(ctx.user.id, {
          botToken: input.token,
          botName: bot.first_name,
          botUsername: bot.username,
          isValid: true,
        });
        return { valid: true, botName: bot.first_name, botUsername: bot.username };
      } else {
        await upsertBotSettings(ctx.user.id, { botToken: input.token, isValid: false });
        return { valid: false, error: res.description ?? "Invalid token" };
      }
    }),
});

const recipientsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getRecipientLists(ctx.user.id);
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      return getRecipientList(input.id, ctx.user.id);
    }),

  upload: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      content: z.string(),
      fileType: z.enum(["json", "csv"]),
    }))
    .mutation(async ({ ctx, input }) => {
      let chatIds: string[] = [];

      if (input.fileType === "json") {
        try {
          const parsed = JSON.parse(input.content);
          if (Array.isArray(parsed)) {
            chatIds = parsed.map(String);
          } else if (parsed.users && Array.isArray(parsed.users)) {
            chatIds = parsed.users.map(String);
          } else if (parsed.chat_ids && Array.isArray(parsed.chat_ids)) {
            chatIds = parsed.chat_ids.map(String);
          } else {
            throw new Error("JSON must be an array or object with 'users'/'chat_ids' key");
          }
        } catch (e: unknown) {
          throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // CSV: one ID per line, skip header if non-numeric
        const lines = input.content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const val = line.split(",")[0].trim();
          if (/^-?\d+$/.test(val)) chatIds.push(val);
        }
      }

      if (chatIds.length === 0) throw new Error("No valid chat IDs found in file");

      // Deduplicate
      chatIds = Array.from(new Set(chatIds));

      const list = await createRecipientList({
        userId: ctx.user.id,
        name: input.name,
        chatIds: JSON.stringify(chatIds),
        totalCount: chatIds.length,
        fileType: input.fileType,
      });

      return list;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await deleteRecipientList(input.id, ctx.user.id);
      return { success: true };
    }),
});

const broadcastRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getBroadcasts(ctx.user.id);
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      return getBroadcast(input.id, ctx.user.id);
    }),

  getLogs: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const bc = await getBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      return getBroadcastLogs(input.id);
    }),

  getProgress: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const prog = broadcastProgress[input.id];
      if (prog) return prog;
      const bc = await getBroadcast(input.id, ctx.user.id);
      if (!bc) return null;
      return { sent: bc.sentCount, failed: bc.failedCount, total: bc.totalRecipients, status: bc.status, running: bc.status === "running" };
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      message: z.string().min(1),
      parseMode: z.enum(["HTML", "Markdown", "MarkdownV2", "None"]),
      delaySeconds: z.number().min(0.5).max(5),
      isDryRun: z.boolean(),
      recipientListId: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const list = await getRecipientList(input.recipientListId, ctx.user.id);
      if (!list) throw new Error("Recipient list not found");

      const bc = await createBroadcast({
        userId: ctx.user.id,
        name: input.name,
        message: input.message,
        parseMode: input.parseMode,
        delaySeconds: input.delaySeconds,
        isDryRun: input.isDryRun,
        recipientListId: input.recipientListId,
        totalRecipients: list.totalCount,
      });

      return bc;
    }),

  launch: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const bc = await getBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      if (bc.status === "running") throw new Error("Already running");

      const botCfg = await getBotSettings(ctx.user.id);
      if (!botCfg?.isValid) throw new Error("No valid bot token configured");

      const list = bc.recipientListId ? await getRecipientList(bc.recipientListId, ctx.user.id) : null;
      if (!list) throw new Error("Recipient list not found");

      const chatIds: string[] = JSON.parse(list.chatIds);

      // Init progress
      broadcastProgress[input.id] = { sent: 0, failed: 0, total: chatIds.length, status: "running", running: true };
      await updateBroadcastStatus(input.id, "running", { startedAt: new Date() });

      // Run async (fire and forget)
      (async () => {
        let sent = 0, failed = 0;
        const delayMs = bc.delaySeconds * 1000;

        for (const chatId of chatIds) {
          if (broadcastProgress[input.id]?.status === "cancelled") break;

          if (bc.isDryRun) {
            // Simulate delay
            await new Promise(r => setTimeout(r, Math.min(delayMs, 100)));
            sent++;
          } else {
            const payload: Record<string, unknown> = {
              chat_id: chatId,
              text: bc.message,
            };
            if (bc.parseMode !== "None") payload.parse_mode = bc.parseMode;

            const res = await telegramRequest(botCfg.botToken, "sendMessage", payload);
            if (res.ok) {
              sent++;
              await createBroadcastLog({ broadcastId: input.id, chatId, success: true });
            } else {
              failed++;
              await createBroadcastLog({ broadcastId: input.id, chatId, success: false, errorMessage: res.description });
            }
            await new Promise(r => setTimeout(r, delayMs));
          }

          broadcastProgress[input.id] = { sent, failed, total: chatIds.length, status: "running", running: true };
          // Persist every 10 messages
          if ((sent + failed) % 10 === 0) {
            await updateBroadcastProgress(input.id, sent, failed);
          }
        }

        const wasCancelled = broadcastProgress[input.id]?.status === "cancelled";
        const finalStatus = wasCancelled ? "cancelled" : "completed";
        const successRate = chatIds.length > 0 ? (sent / chatIds.length) * 100 : 0;

        broadcastProgress[input.id] = { sent, failed, total: chatIds.length, status: finalStatus, running: false };
        await updateBroadcastStatus(input.id, finalStatus, {
          sentCount: sent, failedCount: failed,
          successRate: Math.round(successRate * 10) / 10,
          completedAt: new Date(),
        });
      })().catch(async (err) => {
        broadcastProgress[input.id] = { ...(broadcastProgress[input.id] ?? { sent: 0, failed: 0, total: 0 }), status: "failed", running: false };
        await updateBroadcastStatus(input.id, "failed");
        console.error("[Broadcast] Error:", err);
      });

      return { started: true };
    }),

  cancel: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const bc = await getBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      if (broadcastProgress[input.id]) {
        broadcastProgress[input.id].status = "cancelled";
      }
      await updateBroadcastStatus(input.id, "cancelled");
      return { cancelled: true };
    }),
});

// ── MTProto Router ────────────────────────────────────────────────────────

const mtprotoRouter = router({
  // Get current session status
  getSession: protectedProcedure.query(async ({ ctx }) => {
    return getMtprotoSession(ctx.user.id);
  }),

  // Step 1: Send SMS code to phone number
  sendCode: protectedProcedure
    .input(z.object({ phone: z.string().min(7) }))
    .mutation(async ({ ctx, input }) => {
      const { phoneCodeHash } = await sendPhoneCode(ctx.user.id, input.phone);
      return { sent: true, phoneCodeHash };
    }),

  // Step 2a: Sign in with SMS code
  signIn: protectedProcedure
    .input(z.object({ code: z.string().min(4) }))
    .mutation(async ({ ctx, input }) => {
      const result = await signInWithCode(ctx.user.id, input.code);
      await upsertMtprotoSession(ctx.user.id, {
        phone: result.user.phone,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        username: result.user.username,
        telegramId: result.user.id,
        sessionString: result.sessionString,
        isActive: true,
      });
      return { success: true, user: result.user };
    }),

  // Step 2b: Sign in with 2FA password
  signInPassword: protectedProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await signInWithPassword(ctx.user.id, input.password);
      await upsertMtprotoSession(ctx.user.id, {
        phone: result.user.phone,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        username: result.user.username,
        telegramId: result.user.id,
        sessionString: result.sessionString,
        isActive: true,
      });
      return { success: true, user: result.user };
    }),

  // Logout / disconnect session
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await logoutSession(ctx.user.id);
    await deleteMtprotoSession(ctx.user.id);
    return { success: true };
  }),

  // MTProto Broadcast: list
  listBroadcasts: protectedProcedure.query(async ({ ctx }) => {
    return getMtprotoBroadcasts(ctx.user.id);
  }),

  // MTProto Broadcast: get single
  getBroadcast: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      return getMtprotoBroadcast(input.id, ctx.user.id);
    }),

  // MTProto Broadcast: get logs
  getBroadcastLogs: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const bc = await getMtprotoBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      return getMtprotoBroadcastLogs(input.id);
    }),

  // MTProto Broadcast: get real-time progress
  getProgress: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const prog = mtprotoProgress[input.id];
      if (prog) return prog;
      const bc = await getMtprotoBroadcast(input.id, ctx.user.id);
      if (!bc) return null;
      return { sent: bc.sentCount, failed: bc.failedCount, total: bc.totalRecipients, status: bc.status, running: bc.status === "running" };
    }),

  // MTProto Broadcast: create
  createBroadcast: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      message: z.string().min(1),
      parseMode: z.enum(["HTML", "Markdown", "MarkdownV2", "None"]),
      delaySeconds: z.number().min(1).max(30),
      isDryRun: z.boolean(),
      recipientListId: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const list = await getRecipientList(input.recipientListId, ctx.user.id);
      if (!list) throw new Error("Recipient list not found");

      const session = await getMtprotoSession(ctx.user.id);
      if (!session?.isActive) throw new Error("No active Telegram account connected. Please sign in first.");

      const bc = await createMtprotoBroadcast({
        userId: ctx.user.id,
        name: input.name,
        message: input.message,
        parseMode: input.parseMode,
        delaySeconds: input.delaySeconds,
        isDryRun: input.isDryRun,
        recipientListId: input.recipientListId,
        totalRecipients: list.totalCount,
      });
      return bc;
    }),

  // MTProto Broadcast: launch
  launchBroadcast: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const bc = await getMtprotoBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      if (bc.status === "running") throw new Error("Already running");

      const session = await getMtprotoSession(ctx.user.id);
      if (!session?.sessionString || !session.isActive) {
        throw new Error("No active Telegram account session. Please connect your account first.");
      }

      const list = bc.recipientListId ? await getRecipientList(bc.recipientListId, ctx.user.id) : null;
      if (!list) throw new Error("Recipient list not found");

      const recipients: string[] = JSON.parse(list.chatIds);

      mtprotoProgress[input.id] = { sent: 0, failed: 0, total: recipients.length, status: "running", running: true };
      await updateMtprotoBroadcastStatus(input.id, "running", { startedAt: new Date() });

      // Fire and forget
      (async () => {
        let sent = 0, failed = 0;
        const delayMs = bc.delaySeconds * 1000;

        if (bc.isDryRun) {
          // Simulate without real sending
          for (const recipient of recipients) {
            if (mtprotoProgress[input.id]?.status === "cancelled") break;
            await new Promise(r => setTimeout(r, Math.min(delayMs, 200)));
            sent++;
            mtprotoProgress[input.id] = { sent, failed, total: recipients.length, status: "running", running: true };
          }
        } else {
          const client = await getActiveClient(ctx.user.id, session.sessionString!);
          if (!client) throw new Error("Could not restore Telegram session");

          for (const recipient of recipients) {
            if (mtprotoProgress[input.id]?.status === "cancelled") break;

            const result = await sendMessageToUser(client, recipient, bc.message, bc.parseMode);
            if (result.success) {
              sent++;
              await createMtprotoBroadcastLog({ broadcastId: input.id, recipient, success: true });
            } else {
              failed++;
              await createMtprotoBroadcastLog({ broadcastId: input.id, recipient, success: false, errorMessage: result.error });
            }

            mtprotoProgress[input.id] = { sent, failed, total: recipients.length, status: "running", running: true };
            if ((sent + failed) % 10 === 0) {
              await updateMtprotoBroadcastProgress(input.id, sent, failed);
            }

            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        const wasCancelled = mtprotoProgress[input.id]?.status === "cancelled";
        const finalStatus = wasCancelled ? "cancelled" : "completed";
        const successRate = recipients.length > 0 ? (sent / recipients.length) * 100 : 0;

        mtprotoProgress[input.id] = { sent, failed, total: recipients.length, status: finalStatus, running: false };
        await updateMtprotoBroadcastStatus(input.id, finalStatus, {
          sentCount: sent, failedCount: failed,
          successRate: Math.round(successRate * 10) / 10,
          completedAt: new Date(),
        });
      })().catch(async (err) => {
        mtprotoProgress[input.id] = { ...(mtprotoProgress[input.id] ?? { sent: 0, failed: 0, total: 0 }), status: "failed", running: false };
        await updateMtprotoBroadcastStatus(input.id, "failed");
        console.error("[MTProto Broadcast] Error:", err);
      });

      return { started: true };
    }),

  // MTProto Broadcast: cancel
  cancelBroadcast: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const bc = await getMtprotoBroadcast(input.id, ctx.user.id);
      if (!bc) throw new Error("Broadcast not found");
      if (mtprotoProgress[input.id]) mtprotoProgress[input.id].status = "cancelled";
      await updateMtprotoBroadcastStatus(input.id, "cancelled");
      return { cancelled: true };
    }),
});

const statsRouter = router({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    return getDashboardStats(ctx.user.id);
  }),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(() => {
      return { success: true } as const;
    }),
  }),
  bot: botRouter,
  recipients: recipientsRouter,
  broadcast: broadcastRouter,
  mtproto: mtprotoRouter,
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
