CREATE TYPE "public"."broadcast_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('json', 'csv');--> statement-breakpoint
CREATE TYPE "public"."parse_mode" AS ENUM('HTML', 'Markdown', 'MarkdownV2', 'None');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "bot_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"botToken" varchar(256) NOT NULL,
	"botName" varchar(128),
	"botUsername" varchar(128),
	"isValid" boolean DEFAULT false NOT NULL,
	"validatedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "broadcast_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"broadcastId" integer NOT NULL,
	"chatId" varchar(64) NOT NULL,
	"success" boolean NOT NULL,
	"errorMessage" text,
	"sentAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"message" text NOT NULL,
	"parseMode" "parse_mode" DEFAULT 'HTML' NOT NULL,
	"delaySeconds" real DEFAULT 1 NOT NULL,
	"isDryRun" boolean DEFAULT false NOT NULL,
	"recipientListId" integer,
	"totalRecipients" integer DEFAULT 0 NOT NULL,
	"sentCount" integer DEFAULT 0 NOT NULL,
	"failedCount" integer DEFAULT 0 NOT NULL,
	"successRate" real,
	"status" "broadcast_status" DEFAULT 'pending' NOT NULL,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mtproto_broadcast_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mtproto_broadcast_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"broadcastId" integer NOT NULL,
	"recipient" varchar(128) NOT NULL,
	"success" boolean NOT NULL,
	"errorMessage" text,
	"sentAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mtproto_broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"message" text NOT NULL,
	"parseMode" "parse_mode" DEFAULT 'HTML' NOT NULL,
	"delaySeconds" real DEFAULT 3 NOT NULL,
	"isDryRun" boolean DEFAULT false NOT NULL,
	"recipientListId" integer,
	"totalRecipients" integer DEFAULT 0 NOT NULL,
	"sentCount" integer DEFAULT 0 NOT NULL,
	"failedCount" integer DEFAULT 0 NOT NULL,
	"successRate" real,
	"status" "broadcast_status" DEFAULT 'pending' NOT NULL,
	"startedAt" timestamp,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mtproto_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"phone" varchar(32),
	"firstName" varchar(128),
	"lastName" varchar(128),
	"username" varchar(128),
	"telegramId" varchar(32),
	"sessionString" text,
	"isActive" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mtproto_sessions_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "recipient_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"totalCount" integer DEFAULT 0 NOT NULL,
	"chatIds" text NOT NULL,
	"fileType" "file_type" NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
