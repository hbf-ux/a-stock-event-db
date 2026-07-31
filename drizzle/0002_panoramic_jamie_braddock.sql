CREATE TABLE `user_watchlist` (
	`user_id` text NOT NULL,
	`stock_code` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `stock_code`)
);
--> statement-breakpoint
DROP INDEX `pledge_announcement_shareholder_uq`;--> statement-breakpoint
ALTER TABLE `pledge` ADD `event_fingerprint` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pledge_event_fingerprint_uq` ON `pledge` (`event_fingerprint`);