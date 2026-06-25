CREATE TABLE `bot_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`botToken` varchar(256) NOT NULL,
	`botName` varchar(128),
	`botUsername` varchar(128),
	`isValid` boolean NOT NULL DEFAULT false,
	`validatedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bot_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `broadcast_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`broadcastId` int NOT NULL,
	`chatId` varchar(64) NOT NULL,
	`success` boolean NOT NULL,
	`errorMessage` text,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `broadcast_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(256) NOT NULL,
	`message` text NOT NULL,
	`parseMode` enum('HTML','Markdown','MarkdownV2','None') NOT NULL DEFAULT 'HTML',
	`delaySeconds` float NOT NULL DEFAULT 1,
	`isDryRun` boolean NOT NULL DEFAULT false,
	`recipientListId` int,
	`totalRecipients` int NOT NULL DEFAULT 0,
	`sentCount` int NOT NULL DEFAULT 0,
	`failedCount` int NOT NULL DEFAULT 0,
	`successRate` float,
	`status` enum('pending','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `broadcasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recipient_lists` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(256) NOT NULL,
	`totalCount` int NOT NULL DEFAULT 0,
	`chatIds` text NOT NULL,
	`fileType` enum('json','csv') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recipient_lists_id` PRIMARY KEY(`id`)
);
