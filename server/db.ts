import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  InsertUser,
  users,
  botSettings,
  recipientLists,
  broadcasts,
  broadcastLogs,
  mtprotoSessions,
  mtprotoBroadcasts,
  mtprotoBroadcastLogs,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getPool } from "./connection";
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
} from "./security/secrets";
import type { PoolClient } from "pg";
import { senderKey, type SenderKind } from "./delivery/types";
export { getPool } from "./connection";
export { botSettingsDto, mtprotoSessionDto } from "./security/dto";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db) _db = drizzle(getPool());
  return _db;
}

// ── Users ──────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  for (const field of ["name", "email", "loginMethod"] as const) {
    const v = user[field];
    if (v !== undefined) {
      values[field] = v ?? null;
      updateSet[field] = v ?? null;
    }
  }
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  // PostgreSQL upsert using onConflictDoUpdate
  await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.openId,
      set: updateSet as Partial<InsertUser>,
    });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result[0];
}

// ── Bot Settings ───────────────────────────────────────────────────────────

// Credential changes share the worker's lock, so an already dispatched request
// settles before replacing its credential or the permission scope it relied on.
async function withSenderCredentialTransaction<T>(
  userId: number,
  kind: SenderKind,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const key = senderKey(userId, kind);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `tg-sender:${key}`,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function invalidatePreviousSender(
  client: PoolClient,
  userId: number,
  kind: SenderKind,
  identityChanged: boolean,
  secretChanged: boolean
) {
  if (identityChanged) {
    // Source ingestion locks its source before permissions. Keep the same order.
    await client.query(
      "UPDATE audience_sources SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=$1 AND transport=$2 AND revoked_at IS NULL",
      [userId, kind]
    );
    await client.query(
      "UPDATE automation_rules SET enabled=false WHERE owner_id=$1 AND transport=$2 AND enabled",
      [userId, kind]
    );
    if (kind === "bot")
      await client.query(
        "DELETE FROM telegram_subscription_cursors WHERE owner_id=$1",
        [userId]
      );
    await client.query(
      "UPDATE contact_permissions SET allowed=false,source='sender:identity_changed',updated_at=now() WHERE owner_id=$1 AND kind=$2",
      [userId, kind]
    );
  }
  if (secretChanged) {
    await client.query(
      "UPDATE delivery_campaigns SET status='review_required' WHERE owner_id=$1 AND kind=$2 AND status IN ('queued','running')",
      [userId, kind]
    );
  }
  if (identityChanged || secretChanged) {
    await client.query(
      "INSERT INTO audit_events(owner_id,action,target,detail) VALUES($1,'sender.credential_changed',$2,$3)",
      [userId, kind, JSON.stringify({ identityChanged, secretChanged })]
    );
  }
}

export async function getBotSettings(userId: number) {
  const db = await getDb();
  const result = await db
    .select()
    .from(botSettings)
    .where(eq(botSettings.userId, userId))
    .limit(1);
  const row = result[0];
  return row
    ? { ...row, botToken: decryptSecret(row.botToken, `bot:${userId}`) }
    : null;
}

export async function upsertBotSettings(
  userId: number,
  data: {
    botToken: string;
    botName?: string;
    botUsername?: string;
    isValid: boolean;
  }
) {
  await withSenderCredentialTransaction(userId, "bot", async client => {
    const db = drizzle(client);
    const [previous] = await db
      .select()
      .from(botSettings)
      .where(eq(botSettings.userId, userId))
      .for("update");
    const oldSecret = previous
      ? decryptSecret(previous.botToken, `bot:${userId}`)
      : null;
    const oldIdentity = oldSecret?.match(/^(\d+):/)?.[1];
    const newIdentity = data.botToken.match(/^(\d+):/)?.[1];
    const identityChanged =
      !previous || !oldIdentity || !newIdentity || oldIdentity !== newIdentity;
    await invalidatePreviousSender(
      client,
      userId,
      "bot",
      identityChanged,
      oldSecret !== data.botToken
    );
    const values = {
      ...data,
      botToken: encryptSecret(data.botToken, `bot:${userId}`),
      validatedAt: new Date(),
      updatedAt: new Date(),
    };
    await db
      .insert(botSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: botSettings.userId, set: values });
  });
}

// ── Recipient Lists ────────────────────────────────────────────────────────

export async function getRecipientLists(userId: number) {
  const db = await getDb();
  return db
    .select()
    .from(recipientLists)
    .where(eq(recipientLists.userId, userId))
    .orderBy(desc(recipientLists.createdAt));
}

export async function getRecipientList(id: number, userId: number) {
  const db = await getDb();
  const result = await db
    .select()
    .from(recipientLists)
    .where(and(eq(recipientLists.id, id), eq(recipientLists.userId, userId)))
    .limit(1);
  return result[0] ?? null;
}

export async function createRecipientList(data: {
  userId: number;
  name: string;
  chatIds: string;
  totalCount: number;
  fileType: "json" | "csv";
}) {
  const db = await getDb();
  const result = await db.insert(recipientLists).values(data).returning();
  return result[0];
}

export async function deleteRecipientList(id: number, userId: number) {
  const db = await getDb();
  await db
    .delete(recipientLists)
    .where(and(eq(recipientLists.id, id), eq(recipientLists.userId, userId)));
}

// ── Broadcasts ─────────────────────────────────────────────────────────────

export async function getBroadcasts(userId: number) {
  const db = await getDb();
  return db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.userId, userId))
    .orderBy(desc(broadcasts.createdAt));
}

export async function getBroadcast(id: number, userId: number) {
  const db = await getDb();
  const result = await db
    .select()
    .from(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.userId, userId)))
    .limit(1);
  return result[0] ?? null;
}

export async function createBroadcast(data: {
  userId: number;
  name: string;
  message: string;
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None";
  delaySeconds: number;
  isDryRun: boolean;
  recipientListId?: number;
  totalRecipients: number;
}) {
  const db = await getDb();
  const result = await db
    .insert(broadcasts)
    .values({ ...data, status: "pending" })
    .returning();
  return result[0];
}

export async function updateBroadcastStatus(
  id: number,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  extra?: {
    sentCount?: number;
    failedCount?: number;
    successRate?: number;
    startedAt?: Date;
    completedAt?: Date;
  }
) {
  const db = await getDb();
  await db
    .update(broadcasts)
    .set({ status, ...extra })
    .where(eq(broadcasts.id, id));
}

export async function updateBroadcastProgress(
  id: number,
  sentCount: number,
  failedCount: number
) {
  const db = await getDb();
  await db
    .update(broadcasts)
    .set({ sentCount, failedCount })
    .where(eq(broadcasts.id, id));
}

// ── Broadcast Logs ─────────────────────────────────────────────────────────

export async function createBroadcastLog(data: {
  broadcastId: number;
  chatId: string;
  success: boolean;
  errorMessage?: string;
}) {
  const db = await getDb();
  await db.insert(broadcastLogs).values(data);
}

export async function getBroadcastLogs(broadcastId: number) {
  const db = await getDb();
  return db
    .select()
    .from(broadcastLogs)
    .where(eq(broadcastLogs.broadcastId, broadcastId))
    .orderBy(desc(broadcastLogs.sentAt))
    .limit(500);
}

// ── MTProto Sessions ──────────────────────────────────────────────────────

export async function getMtprotoSession(userId: number) {
  const db = await getDb();
  const result = await db
    .select()
    .from(mtprotoSessions)
    .where(eq(mtprotoSessions.userId, userId))
    .limit(1);
  const row = result[0];
  return row
    ? {
        ...row,
        sessionString: row.sessionString
          ? decryptSecret(row.sessionString, `mtproto:${userId}`)
          : null,
      }
    : null;
}

export async function upsertMtprotoSession(
  userId: number,
  data: {
    phone?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    telegramId?: string;
    sessionString?: string;
    isActive: boolean;
  }
) {
  return withSenderCredentialTransaction(userId, "mtproto", async client => {
    const db = drizzle(client);
    const [previous] = await db
      .select()
      .from(mtprotoSessions)
      .where(eq(mtprotoSessions.userId, userId))
      .for("update");
    const oldSecret = previous?.sessionString
      ? decryptSecret(previous.sessionString, `mtproto:${userId}`)
      : null;
    const nextSecret =
      data.sessionString === undefined ? oldSecret : data.sessionString;
    const nextIdentity =
      data.telegramId === undefined ? previous?.telegramId : data.telegramId;
    const identityChanged =
      !previous ||
      !previous.telegramId ||
      !nextIdentity ||
      previous.telegramId !== nextIdentity;
    await invalidatePreviousSender(
      client,
      userId,
      "mtproto",
      identityChanged,
      oldSecret !== nextSecret
    );
    const values = {
      ...data,
      ...(data.sessionString !== undefined
        ? {
            sessionString: encryptSecret(
              data.sessionString,
              `mtproto:${userId}`
            ),
          }
        : {}),
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(mtprotoSessions)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: mtprotoSessions.userId, set: values })
      .returning();
    return { ...row, sessionString: nextSecret };
  });
}

export async function deleteMtprotoSession(userId: number) {
  const db = await getDb();
  await db.delete(mtprotoSessions).where(eq(mtprotoSessions.userId, userId));
}

// ── MTProto Broadcasts ─────────────────────────────────────────────────────

export async function getMtprotoBroadcasts(userId: number) {
  const db = await getDb();
  return db
    .select()
    .from(mtprotoBroadcasts)
    .where(eq(mtprotoBroadcasts.userId, userId))
    .orderBy(desc(mtprotoBroadcasts.createdAt));
}

export async function getMtprotoBroadcast(id: number, userId: number) {
  const db = await getDb();
  const result = await db
    .select()
    .from(mtprotoBroadcasts)
    .where(
      and(eq(mtprotoBroadcasts.id, id), eq(mtprotoBroadcasts.userId, userId))
    )
    .limit(1);
  return result[0] ?? null;
}

export async function createMtprotoBroadcast(data: {
  userId: number;
  name: string;
  message: string;
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None";
  delaySeconds: number;
  isDryRun: boolean;
  recipientListId?: number;
  totalRecipients: number;
}) {
  const db = await getDb();
  const result = await db
    .insert(mtprotoBroadcasts)
    .values({ ...data, status: "pending" })
    .returning();
  return result[0];
}

export async function updateMtprotoBroadcastStatus(
  id: number,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  extra?: {
    sentCount?: number;
    failedCount?: number;
    successRate?: number;
    startedAt?: Date;
    completedAt?: Date;
  }
) {
  const db = await getDb();
  await db
    .update(mtprotoBroadcasts)
    .set({ status, ...extra })
    .where(eq(mtprotoBroadcasts.id, id));
}

export async function updateMtprotoBroadcastProgress(
  id: number,
  sentCount: number,
  failedCount: number
) {
  const db = await getDb();
  await db
    .update(mtprotoBroadcasts)
    .set({ sentCount, failedCount })
    .where(eq(mtprotoBroadcasts.id, id));
}

export async function createMtprotoBroadcastLog(data: {
  broadcastId: number;
  recipient: string;
  success: boolean;
  errorMessage?: string;
}) {
  const db = await getDb();
  await db.insert(mtprotoBroadcastLogs).values(data);
}

export async function getMtprotoBroadcastLogs(broadcastId: number) {
  const db = await getDb();
  return db
    .select()
    .from(mtprotoBroadcastLogs)
    .where(eq(mtprotoBroadcastLogs.broadcastId, broadcastId))
    .orderBy(desc(mtprotoBroadcastLogs.sentAt))
    .limit(1000);
}

// ── Resume / reconciliation helpers ─────────────────────────────────────────

export async function getSucceededChatIds(
  broadcastId: number
): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ chatId: broadcastLogs.chatId })
    .from(broadcastLogs)
    .where(
      and(
        eq(broadcastLogs.broadcastId, broadcastId),
        eq(broadcastLogs.success, true)
      )
    );
  return rows.map(r => r.chatId);
}

export async function getSucceededRecipients(
  broadcastId: number
): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ recipient: mtprotoBroadcastLogs.recipient })
    .from(mtprotoBroadcastLogs)
    .where(
      and(
        eq(mtprotoBroadcastLogs.broadcastId, broadcastId),
        eq(mtprotoBroadcastLogs.success, true)
      )
    );
  return rows.map(r => r.recipient);
}

// Durable delivery workers own recovery. A process startup must never reset work
// belonging to another live worker or silently retry an uncertain delivery.
export async function reconcileStaleBroadcasts(): Promise<void> {
  await getPool().query("SELECT 1");
}

// Called only by the explicit maintenance command after a database/key backup.
export async function migrateLegacySecrets(): Promise<{
  botTokens: number;
  mtprotoSessions: number;
}> {
  const client = await getPool().connect();
  const counts = { botTokens: 0, mtprotoSessions: 0 };
  try {
    await client.query("BEGIN");
    const bots = await client.query<{
      id: number;
      userId: number;
      botToken: string;
    }>('SELECT id,"userId","botToken" FROM bot_settings FOR UPDATE');
    for (const row of bots.rows) {
      if (isEncryptedSecret(row.botToken)) {
        decryptSecret(row.botToken, `bot:${row.userId}`);
      } else {
        await client.query(
          'UPDATE bot_settings SET "botToken"=$1,"updatedAt"=now() WHERE id=$2',
          [encryptSecret(row.botToken, `bot:${row.userId}`), row.id]
        );
        counts.botTokens++;
      }
    }
    const sessions = await client.query<{
      id: number;
      userId: number;
      sessionString: string | null;
    }>('SELECT id,"userId","sessionString" FROM mtproto_sessions FOR UPDATE');
    for (const row of sessions.rows) {
      if (row.sessionString && isEncryptedSecret(row.sessionString)) {
        decryptSecret(row.sessionString, `mtproto:${row.userId}`);
      } else if (row.sessionString) {
        await client.query(
          'UPDATE mtproto_sessions SET "sessionString"=$1,"updatedAt"=now() WHERE id=$2',
          [encryptSecret(row.sessionString, `mtproto:${row.userId}`), row.id]
        );
        counts.mtprotoSessions++;
      }
    }
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────

export async function getDashboardStats(userId: number) {
  const db = await getDb();

  const allBroadcasts = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.userId, userId))
    .orderBy(desc(broadcasts.createdAt));

  const completed = allBroadcasts.filter(b => b.status === "completed");
  const totalMessagesSent = completed.reduce((s, b) => s + b.sentCount, 0);
  const totalAttempted = completed.reduce((s, b) => s + b.totalRecipients, 0);
  const overallSuccessRate =
    totalAttempted > 0 ? (totalMessagesSent / totalAttempted) * 100 : 0;

  return {
    totalBroadcasts: allBroadcasts.length,
    totalMessagesSent,
    overallSuccessRate: Math.round(overallSuccessRate * 10) / 10,
    recentBroadcasts: allBroadcasts.slice(0, 5),
  };
}
