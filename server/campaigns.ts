import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getPool } from "./connection";
import * as db from "./db";
import { enqueueCampaign, getProgress } from "./delivery";
import type { Broadcast } from "../drizzle/schema";
import type { SenderKind, ParseMode } from "./delivery/types";
import { normalizeRecipient } from "./delivery/types";
import { senderFingerprint } from "./senderIdentity";

export interface CampaignInput {
  name: string;
  message: string;
  parseMode: Exclude<ParseMode, null>;
  delaySeconds: number;
  isDryRun: boolean;
  recipientListId: number;
  requestKey?: string;
  approved?: boolean;
}
export async function createCampaign(
  ownerId: number,
  kind: SenderKind,
  input: CampaignInput,
  explicitRecipients?: string[],
  expectedSenderFingerprint?: string | null
) {
  if (!input.isDryRun && !input.approved)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Подтвердите текст и аудиторию перед реальной отправкой",
    });
  if (!input.isDryRun && process.env.LIVE_SEND_ENABLED !== "true")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Реальная отправка выключена. Доступен тестовый запуск.",
    });
  const list = await db.getRecipientList(input.recipientListId, ownerId);
  if (!list && !explicitRecipients)
    throw new TRPCError({ code: "NOT_FOUND", message: "Список не найден" });
  const recipients: string[] = explicitRecipients ?? JSON.parse(list!.chatIds);
  const fingerprint = input.isDryRun
    ? null
    : await senderFingerprint(ownerId, kind);
  if (
    expectedSenderFingerprint !== undefined &&
    fingerprint !== expectedSenderFingerprint
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Утверждённый отправитель изменился. Проверьте сценарий.",
    });
  const requestKey = input.requestKey ?? randomUUID();
  const pool = getPool(),
    tx = await pool.connect();
  const table = kind === "bot" ? "broadcasts" : "mtproto_broadcasts";
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `create:${ownerId}:${kind}:${requestKey}`,
    ]);
    const prior = await tx.query(
      "SELECT broadcast_id,recipients,sender_fingerprint FROM campaign_snapshots WHERE owner_id=$1 AND kind=$2 AND request_key=$3",
      [ownerId, kind, requestKey]
    );
    if (prior.rowCount) {
      const found = await tx.query(
        `SELECT * FROM ${table} WHERE id=$1 AND "userId"=$2`,
        [prior.rows[0].broadcast_id, ownerId]
      );
      const bc = found.rows[0] as Broadcast;
      const canonical = (values: string[]) =>
        JSON.stringify([...new Set(values.map(normalizeRecipient))].sort());
      if (
        bc.message !== input.message ||
        bc.name !== input.name ||
        bc.parseMode !== input.parseMode ||
        bc.isDryRun !== input.isDryRun ||
        bc.recipientListId !== input.recipientListId ||
        bc.delaySeconds !==
          Math.max(kind === "bot" ? 1 : 3, input.delaySeconds) ||
        canonical(prior.rows[0].recipients) !== canonical(recipients) ||
        prior.rows[0].sender_fingerprint !== fingerprint
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "Ключ повтора уже относится к другой кампании",
        });
      await tx.query("COMMIT");
      return bc;
    }
    const r = await tx.query(
      `INSERT INTO ${table} ("userId",name,message,"parseMode","delaySeconds","isDryRun","recipientListId","totalRecipients") VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        ownerId,
        input.name,
        input.message,
        input.parseMode,
        Math.max(kind === "bot" ? 1 : 3, input.delaySeconds),
        input.isDryRun,
        input.recipientListId,
        recipients.length,
      ]
    );
    const bc = r.rows[0] as Broadcast;
    await tx.query(
      "INSERT INTO campaign_snapshots(owner_id,kind,broadcast_id,request_key,recipients,sender_fingerprint) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ownerId,
        kind,
        bc.id,
        requestKey,
        JSON.stringify(recipients),
        fingerprint,
      ]
    );
    await tx.query(
      "INSERT INTO audit_events(owner_id,action,target) VALUES($1,$2,$3)",
      [ownerId, "campaign.approved", `${kind}:${bc.id}`]
    );
    await tx.query("COMMIT");
    return bc;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function launchCampaign(
  ownerId: number,
  kind: SenderKind,
  id: number
) {
  const bc =
    kind === "bot"
      ? await db.getBroadcast(id, ownerId)
      : await db.getMtprotoBroadcast(id, ownerId);
  if (!bc)
    throw new TRPCError({ code: "NOT_FOUND", message: "Кампания не найдена" });
  if (!bc.isDryRun && process.env.LIVE_SEND_ENABLED !== "true")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Реальная отправка выключена",
    });
  const snap = await getPool().query(
    "SELECT recipients,sender_fingerprint FROM campaign_snapshots WHERE owner_id=$1 AND kind=$2 AND broadcast_id=$3",
    [ownerId, kind, id]
  );
  if (!snap.rowCount)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Старая кампания без снимка. Создайте новую после проверки аудитории.",
    });
  await enqueueCampaign({
    ownerId,
    kind,
    broadcastId: id,
    message: bc.message,
    parseMode: bc.parseMode,
    delaySeconds: bc.delaySeconds,
    isDryRun: bc.isDryRun,
    recipients: snap.rows[0].recipients,
    senderFingerprint: snap.rows[0].sender_fingerprint ?? undefined,
    expiresAt: new Date(new Date(bc.createdAt).getTime() + 7 * 86400000),
  });
  return { started: true };
}
export async function enrichedCampaign<T extends Broadcast>(
  ownerId: number,
  kind: SenderKind,
  bc: T | null
) {
  if (!bc) return null;
  const progress = await getProgress(ownerId, kind, bc.id);
  return { ...bc, queueStatus: progress?.status ?? bc.status, progress };
}
