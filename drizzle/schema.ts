import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
  real,
  boolean,
  bigint,
  serial,
} from "drizzle-orm/pg-core";

// Enums
export const roleEnum = pgEnum("role", ["user", "admin"]);
export const fileTypeEnum = pgEnum("file_type", ["json", "csv"]);
export const parseModeEnum = pgEnum("parse_mode", ["HTML", "Markdown", "MarkdownV2", "None"]);
export const broadcastStatusEnum = pgEnum("broadcast_status", ["pending", "running", "completed", "failed", "cancelled"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Bot settings — one row per user
export const botSettings = pgTable("bot_settings", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  botToken: varchar("botToken", { length: 256 }).notNull(),
  botName: varchar("botName", { length: 128 }),
  botUsername: varchar("botUsername", { length: 128 }),
  isValid: boolean("isValid").default(false).notNull(),
  validatedAt: timestamp("validatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type BotSettings = typeof botSettings.$inferSelect;

// Recipient lists
export const recipientLists = pgTable("recipient_lists", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  totalCount: integer("totalCount").default(0).notNull(),
  chatIds: text("chatIds").notNull(), // JSON array stored as text
  fileType: fileTypeEnum("fileType").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RecipientList = typeof recipientLists.$inferSelect;

// Broadcasts
export const broadcasts = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  message: text("message").notNull(),
  parseMode: parseModeEnum("parseMode").default("HTML").notNull(),
  delaySeconds: real("delaySeconds").default(1.0).notNull(),
  isDryRun: boolean("isDryRun").default(false).notNull(),
  recipientListId: integer("recipientListId"),
  totalRecipients: integer("totalRecipients").default(0).notNull(),
  sentCount: integer("sentCount").default(0).notNull(),
  failedCount: integer("failedCount").default(0).notNull(),
  successRate: real("successRate"),
  status: broadcastStatusEnum("status").default("pending").notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type Broadcast = typeof broadcasts.$inferSelect;

// Per-message logs for each broadcast
export const broadcastLogs = pgTable("broadcast_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  broadcastId: integer("broadcastId").notNull(),
  chatId: varchar("chatId", { length: 64 }).notNull(),
  success: boolean("success").notNull(),
  errorMessage: text("errorMessage"),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type BroadcastLog = typeof broadcastLogs.$inferSelect;

// MTProto user account sessions
export const mtprotoSessions = pgTable("mtproto_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull().unique(),
  phone: varchar("phone", { length: 32 }),
  firstName: varchar("firstName", { length: 128 }),
  lastName: varchar("lastName", { length: 128 }),
  username: varchar("username", { length: 128 }),
  telegramId: varchar("telegramId", { length: 32 }),
  sessionString: text("sessionString"),
  isActive: boolean("isActive").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type MtprotoSession = typeof mtprotoSessions.$inferSelect;

// MTProto broadcasts (sent via user account)
export const mtprotoBroadcasts = pgTable("mtproto_broadcasts", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  message: text("message").notNull(),
  parseMode: parseModeEnum("parseMode").default("HTML").notNull(),
  delaySeconds: real("delaySeconds").default(3.0).notNull(),
  isDryRun: boolean("isDryRun").default(false).notNull(),
  recipientListId: integer("recipientListId"),
  totalRecipients: integer("totalRecipients").default(0).notNull(),
  sentCount: integer("sentCount").default(0).notNull(),
  failedCount: integer("failedCount").default(0).notNull(),
  successRate: real("successRate"),
  status: broadcastStatusEnum("status").default("pending").notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type MtprotoBroadcast = typeof mtprotoBroadcasts.$inferSelect;

// Per-message logs for MTProto broadcasts
export const mtprotoBroadcastLogs = pgTable("mtproto_broadcast_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  broadcastId: integer("broadcastId").notNull(),
  recipient: varchar("recipient", { length: 128 }).notNull(),
  success: boolean("success").notNull(),
  errorMessage: text("errorMessage"),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type MtprotoBroadcastLog = typeof mtprotoBroadcastLogs.$inferSelect;
