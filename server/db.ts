import { eq, desc, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { InsertUser, users, botSettings, recipientLists, broadcasts, broadcastLogs, mtprotoSessions, mtprotoBroadcasts, mtprotoBroadcastLogs } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

function getPostgresUrl(): string | undefined {
  // Prefer SUPABASE_DATABASE_URL (explicit Supabase connection)
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL;
  // Fall back to DATABASE_URL only if it's PostgreSQL (not MySQL)
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith('postgresql')) return url;
  return undefined;
}

export async function getDb() {
  const pgUrl = getPostgresUrl();
  if (!_db && pgUrl) {
    try {
      const pool = new Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ── Users ──────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  for (const field of ["name", "email", "loginMethod"] as const) {
    const v = user[field];
    if (v !== undefined) { values[field] = v ?? null; updateSet[field] = v ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  // PostgreSQL upsert using onConflictDoUpdate
  await db.insert(users).values(values).onConflictDoUpdate({
    target: users.openId,
    set: updateSet as Partial<InsertUser>,
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

// ── Bot Settings ───────────────────────────────────────────────────────────

export async function getBotSettings(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(botSettings).where(eq(botSettings.userId, userId)).limit(1);
  return result[0] ?? null;
}

export async function upsertBotSettings(
  userId: number,
  data: { botToken: string; botName?: string; botUsername?: string; isValid: boolean }
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await getBotSettings(userId);
  if (existing) {
    await db.update(botSettings)
      .set({ ...data, validatedAt: new Date() })
      .where(eq(botSettings.userId, userId));
  } else {
    await db.insert(botSettings).values({ userId, ...data, validatedAt: new Date() });
  }
}

// ── Recipient Lists ────────────────────────────────────────────────────────

export async function getRecipientLists(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(recipientLists).where(eq(recipientLists.userId, userId)).orderBy(desc(recipientLists.createdAt));
}

export async function getRecipientList(id: number, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(recipientLists)
    .where(and(eq(recipientLists.id, id), eq(recipientLists.userId, userId))).limit(1);
  return result[0] ?? null;
}

export async function createRecipientList(data: {
  userId: number; name: string; chatIds: string; totalCount: number; fileType: "json" | "csv";
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(recipientLists).values(data);
  const result = await db.select().from(recipientLists)
    .where(eq(recipientLists.userId, data.userId)).orderBy(desc(recipientLists.createdAt)).limit(1);
  return result[0];
}

export async function deleteRecipientList(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(recipientLists).where(and(eq(recipientLists.id, id), eq(recipientLists.userId, userId)));
}

// ── Broadcasts ─────────────────────────────────────────────────────────────

export async function getBroadcasts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(broadcasts).where(eq(broadcasts.userId, userId)).orderBy(desc(broadcasts.createdAt));
}

export async function getBroadcast(id: number, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.userId, userId))).limit(1);
  return result[0] ?? null;
}

export async function createBroadcast(data: {
  userId: number; name: string; message: string;
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None";
  delaySeconds: number; isDryRun: boolean;
  recipientListId?: number; totalRecipients: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(broadcasts).values({ ...data, status: "pending" });
  const result = await db.select().from(broadcasts)
    .where(eq(broadcasts.userId, data.userId)).orderBy(desc(broadcasts.createdAt)).limit(1);
  return result[0];
}

export async function updateBroadcastStatus(
  id: number,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  extra?: { sentCount?: number; failedCount?: number; successRate?: number; startedAt?: Date; completedAt?: Date }
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(broadcasts).set({ status, ...extra }).where(eq(broadcasts.id, id));
}

export async function updateBroadcastProgress(id: number, sentCount: number, failedCount: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(broadcasts).set({ sentCount, failedCount }).where(eq(broadcasts.id, id));
}

// ── Broadcast Logs ─────────────────────────────────────────────────────────

export async function createBroadcastLog(data: {
  broadcastId: number; chatId: string; success: boolean; errorMessage?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(broadcastLogs).values(data);
}

export async function getBroadcastLogs(broadcastId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(broadcastLogs)
    .where(eq(broadcastLogs.broadcastId, broadcastId))
    .orderBy(desc(broadcastLogs.sentAt))
    .limit(500);
}

// ── MTProto Sessions ──────────────────────────────────────────────────────

export async function getMtprotoSession(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(mtprotoSessions).where(eq(mtprotoSessions.userId, userId)).limit(1);
  return result[0] ?? null;
}

export async function upsertMtprotoSession(userId: number, data: {
  phone?: string; firstName?: string; lastName?: string;
  username?: string; telegramId?: string; sessionString?: string; isActive: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await getMtprotoSession(userId);
  if (existing) {
    await db.update(mtprotoSessions).set(data).where(eq(mtprotoSessions.userId, userId));
  } else {
    await db.insert(mtprotoSessions).values({ userId, ...data });
  }
  return getMtprotoSession(userId);
}

export async function deleteMtprotoSession(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(mtprotoSessions).where(eq(mtprotoSessions.userId, userId));
}

// ── MTProto Broadcasts ─────────────────────────────────────────────────────

export async function getMtprotoBroadcasts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(mtprotoBroadcasts).where(eq(mtprotoBroadcasts.userId, userId)).orderBy(desc(mtprotoBroadcasts.createdAt));
}

export async function getMtprotoBroadcast(id: number, userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(mtprotoBroadcasts)
    .where(and(eq(mtprotoBroadcasts.id, id), eq(mtprotoBroadcasts.userId, userId))).limit(1);
  return result[0] ?? null;
}

export async function createMtprotoBroadcast(data: {
  userId: number; name: string; message: string;
  parseMode: "HTML" | "Markdown" | "MarkdownV2" | "None";
  delaySeconds: number; isDryRun: boolean;
  recipientListId?: number; totalRecipients: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(mtprotoBroadcasts).values({ ...data, status: "pending" });
  const result = await db.select().from(mtprotoBroadcasts)
    .where(eq(mtprotoBroadcasts.userId, data.userId)).orderBy(desc(mtprotoBroadcasts.createdAt)).limit(1);
  return result[0];
}

export async function updateMtprotoBroadcastStatus(
  id: number,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  extra?: { sentCount?: number; failedCount?: number; successRate?: number; startedAt?: Date; completedAt?: Date }
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(mtprotoBroadcasts).set({ status, ...extra }).where(eq(mtprotoBroadcasts.id, id));
}

export async function updateMtprotoBroadcastProgress(id: number, sentCount: number, failedCount: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(mtprotoBroadcasts).set({ sentCount, failedCount }).where(eq(mtprotoBroadcasts.id, id));
}

export async function createMtprotoBroadcastLog(data: {
  broadcastId: number; recipient: string; success: boolean; errorMessage?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(mtprotoBroadcastLogs).values(data);
}

export async function getMtprotoBroadcastLogs(broadcastId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(mtprotoBroadcastLogs)
    .where(eq(mtprotoBroadcastLogs.broadcastId, broadcastId))
    .orderBy(desc(mtprotoBroadcastLogs.sentAt))
    .limit(1000);
}

// ── Resume / reconciliation helpers ─────────────────────────────────────────

export async function getSucceededChatIds(broadcastId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ chatId: broadcastLogs.chatId }).from(broadcastLogs)
    .where(and(eq(broadcastLogs.broadcastId, broadcastId), eq(broadcastLogs.success, true)));
  return rows.map(r => r.chatId);
}

export async function getSucceededRecipients(broadcastId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ recipient: mtprotoBroadcastLogs.recipient }).from(mtprotoBroadcastLogs)
    .where(and(eq(mtprotoBroadcastLogs.broadcastId, broadcastId), eq(mtprotoBroadcastLogs.success, true)));
  return rows.map(r => r.recipient);
}

// On startup, any broadcast left in "running" (process was killed mid-send) is
// marked failed so it can be safely relaunched — resume then skips delivered ones.
export async function reconcileStaleBroadcasts(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(broadcasts).set({ status: "failed" }).where(eq(broadcasts.status, "running"));
  await db.update(mtprotoBroadcasts).set({ status: "failed" }).where(eq(mtprotoBroadcasts.status, "running"));
}

// ── Stats ──────────────────────────────────────────────────────────────────

export async function getDashboardStats(userId: number) {
  const db = await getDb();
  if (!db) return { totalBroadcasts: 0, totalMessagesSent: 0, overallSuccessRate: 0, recentBroadcasts: [] };

  const allBroadcasts = await db.select().from(broadcasts)
    .where(eq(broadcasts.userId, userId)).orderBy(desc(broadcasts.createdAt));

  const completed = allBroadcasts.filter(b => b.status === "completed");
  const totalMessagesSent = completed.reduce((s, b) => s + b.sentCount, 0);
  const totalAttempted = completed.reduce((s, b) => s + b.totalRecipients, 0);
  const overallSuccessRate = totalAttempted > 0 ? (totalMessagesSent / totalAttempted) * 100 : 0;

  return {
    totalBroadcasts: allBroadcasts.length,
    totalMessagesSent,
    overallSuccessRate: Math.round(overallSuccessRate * 10) / 10,
    recentBroadcasts: allBroadcasts.slice(0, 5),
  };
}
