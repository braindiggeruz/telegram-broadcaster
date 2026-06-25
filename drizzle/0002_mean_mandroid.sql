CREATE TABLE `mtproto_broadcast_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`broadcastId` int NOT NULL,
	`recipient` varchar(128) NOT NULL,
	`success` boolean NOT NULL,
	`errorMessage` text,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mtproto_broadcast_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mtproto_broadcasts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(256) NOT NULL,
	`message` text NOT NULL,
	`parseMode` enum('HTML','Markdown','MarkdownV2','None') NOT NULL DEFAULT 'HTML',
	`delaySeconds` float NOT NULL DEFAULT 3,
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
	CONSTRAINT `mtproto_broadcasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mtproto_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`phone` varchar(32),
	`firstName` varchar(128),
	`lastName` varchar(128),
	`username` varchar(128),
	`telegramId` varchar(32),
	`sessionString` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mtproto_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mtproto_sessions_userId_unique` UNIQUE(`userId`)
);
