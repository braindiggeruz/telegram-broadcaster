import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { TRPCError } from "@trpc/server";
import { getBotSettings } from "./db";
import { getPool } from "./connection";
import { telegramRequest } from "./telegramTransport";
function webhookSecret(ownerId: number, token: string) {
  const key = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!key || key.length < 32) throw new Error("WEBHOOK_SECRET_REQUIRED");
  return createHmac("sha256", key).update(`${ownerId}:${token}`).digest("hex");
}
export async function configureTelegramWebhook(ownerId: number) {
  const origin = new URL(process.env.APP_ORIGIN!);
  if (origin.protocol !== "https:")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Для приёма Telegram-событий нужен публичный HTTPS-адрес сервиса",
    });
  const settings = await getBotSettings(ownerId);
  if (!settings?.isValid)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Сначала подключите бота",
    });
  const result = await telegramRequest(settings.botToken, "setWebhook", {
    url: `${origin.origin}/api/telegram/${ownerId}/updates`,
    secret_token: webhookSecret(ownerId, settings.botToken),
    allowed_updates: ["message", "my_chat_member"],
    drop_pending_updates: false,
  });
  if (!result.ok)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Telegram не подтвердил webhook",
    });
  return {
    configured: true,
    subscribeCommand: "/subscribe",
    unsubscribeCommand: "/stop",
  };
}
export function registerTelegramWebhook(app: Express) {
  app.post("/api/telegram/:ownerId/updates", async (req, res) => {
    try {
      const ownerId = Number(req.params.ownerId),
        secret = req.headers["x-telegram-bot-api-secret-token"];
      if (
        !Number.isSafeInteger(ownerId) ||
        ownerId < 1 ||
        typeof secret !== "string" ||
        !/^[a-f0-9]{64}$/.test(secret)
      ) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const settings = await getBotSettings(ownerId);
      if (
        !settings ||
        !timingSafeEqual(
          Buffer.from(secret),
          Buffer.from(webhookSecret(ownerId, settings.botToken))
        )
      ) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const update = req.body;
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        res.status(400).json({ error: "INVALID_UPDATE" });
        return;
      }
      const commandParts =
        typeof update.message?.text === "string"
          ? update.message.text.trim().split(/\s/)[0].toLowerCase().split("@")
          : [];
      if (
        commandParts[1] &&
        commandParts[1] !== settings.botUsername?.toLowerCase()
      ) {
        res.json({ ok: true });
        return;
      }
      const command = commandParts[0] ?? "";
      const membership = update.my_chat_member;
      const blocked = membership?.new_chat_member?.status === "kicked";
      const allowed = command === "/subscribe";
      const unsubscribe =
        ["/stop", "/unsubscribe"].includes(command) || blocked;
      const chat = blocked ? membership.chat : update.message?.chat;
      const eventDate = blocked ? membership.date : update.message?.date;
      if (
        (!allowed && !unsubscribe) ||
        chat?.type !== "private" ||
        !Number.isSafeInteger(chat.id)
      ) {
        res.json({ ok: true });
        return;
      }
      if (
        !Number.isSafeInteger(eventDate) ||
        eventDate < 0 ||
        eventDate > Date.now() / 1000 + 300
      ) {
        res.status(400).json({ error: "INVALID_DATE" });
        return;
      }
      const recipient = `chat:${chat.id}`;
      const tx = await getPool().connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `tg-sender:${ownerId}:bot`,
        ]);
        // Replacement credentials use the same lock. An update authenticated
        // against the old bot must never grant consent to its replacement.
        const currentSettings = await getBotSettings(ownerId);
        if (
          !currentSettings ||
          !timingSafeEqual(
            Buffer.from(secret),
            Buffer.from(webhookSecret(ownerId, currentSettings.botToken))
          )
        ) {
          await tx.query("ROLLBACK");
          res.status(401).json({ error: "UNAUTHORIZED" });
          return;
        }
        if (
          commandParts[1] &&
          commandParts[1] !== currentSettings.botUsername?.toLowerCase()
        ) {
          await tx.query("ROLLBACK");
          res.json({ ok: true });
          return;
        }
        const cursor = await tx.query(
          `INSERT INTO telegram_subscription_cursors(owner_id,recipient,last_update_id,last_event_date) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,recipient) DO UPDATE SET last_update_id=excluded.last_update_id,last_event_date=excluded.last_event_date WHERE (telegram_subscription_cursors.last_event_date,telegram_subscription_cursors.last_update_id)<(excluded.last_event_date,excluded.last_update_id) RETURNING last_update_id`,
          [ownerId, recipient, update.update_id, eventDate]
        );
        if (cursor.rowCount) {
          const permission = await tx.query(
            `INSERT INTO contact_permissions(owner_id,kind,recipient,allowed,source,suppressed_at) VALUES($1,'bot',$2,$3,$4,CASE WHEN $3 THEN NULL ELSE now() END)
            ON CONFLICT(owner_id,kind,recipient) DO UPDATE SET
              allowed=CASE WHEN excluded.allowed AND contact_permissions.suppressed_at>=to_timestamp($5) THEN false ELSE excluded.allowed END,
              source=CASE WHEN excluded.allowed AND contact_permissions.suppressed_at>=to_timestamp($5) THEN contact_permissions.source ELSE excluded.source END,
              suppressed_at=CASE WHEN excluded.allowed AND contact_permissions.suppressed_at>=to_timestamp($5) THEN contact_permissions.suppressed_at ELSE excluded.suppressed_at END,updated_at=now() RETURNING allowed`,
            [
              ownerId,
              recipient,
              allowed,
              allowed ? "telegram:/subscribe" : "telegram:/stop",
              eventDate,
            ]
          );
          const action = allowed
            ? permission.rows[0].allowed
              ? "contact.subscribed"
              : "contact.stale_subscribe_ignored"
            : "contact.unsubscribed";
          await tx.query(
            "INSERT INTO audit_events(owner_id,action,target) VALUES($1,$2,$3)",
            [ownerId, action, recipient]
          );
        }
        await tx.query("COMMIT");
        res.json({ ok: true });
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
    } catch {
      res.status(503).json({ error: "UPDATE_UNAVAILABLE" });
    }
  });
}
