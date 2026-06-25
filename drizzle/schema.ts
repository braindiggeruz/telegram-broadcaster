import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  float,
  boolean,
  bigint,
  json,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Bot settings — one row per user
export const botSettings = mysqlTable("bot_settings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  botToken: varchar("botToken", { length: 256 }).notNull(),
  botName: varchar("botName", { length: 128 }),
  botUsername: varchar("botUsername", { length: 128 }),
  isValid: boolean("isValid").default(false).notNull(),
  validatedAt: timestamp("validatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type BotSettings = typeof botSettings.$inferSelect;

// Recipient lists
export const recipientLists = mysqlTable("recipient_lists", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  totalCount: int("totalCount").default(0).notNull(),
  chatIds: text("chatIds").notNull(), // JSON array stored as text
  fileType: mysqlEnum("fileType", ["json", "csv"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RecipientList = typeof recipientLists.$inferSelect;

// Broadcasts
export const broadcasts = mysqlTable("broadcasts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  message: text("message").notNull(),
  parseMode: mysqlEnum("parseMode", ["HTML", "Markdown", "MarkdownV2", "None"]).default("HTML").notNull(),
  delaySeconds: float("delaySeconds").default(1.0).notNull(),
  isDryRun: boolean("isDryRun").default(false).notNull(),
  recipientListId: int("recipientListId"),
  totalRecipients: int("totalRecipients").default(0).notNull(),
  sentCount: int("sentCount").default(0).notNull(),
  failedCount: int("failedCount").default(0).notNull(),
  successRate: float("successRate"),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "cancelled"]).default("pending").notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Broadcast = typeof broadcasts.$inferSelect;

// Per-message logs for each broadcast
export const broadcastLogs = mysqlTable("broadcast_logs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  broadcastId: int("broadcastId").notNull(),
  chatId: varchar("chatId", { length: 64 }).notNull(),
  success: boolean("success").notNull(),
  errorMessage: text("errorMessage"),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type BroadcastLog = typeof broadcastLogs.$inferSelect;
