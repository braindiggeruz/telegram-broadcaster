import { eq, desc, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, botSettings, recipientLists, broadcasts, broadcastLogs } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
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

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
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
