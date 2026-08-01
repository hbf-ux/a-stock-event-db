CREATE TABLE `exchange_observation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_announcement_id` text NOT NULL,
	`stock_code` text NOT NULL,
	`stock_name` text NOT NULL,
	`title` text NOT NULL,
	`announce_date` text NOT NULL,
	`pdf_url` text,
	`title_fingerprint` text NOT NULL,
	`match_status` text DEFAULT 'unmatched' NOT NULL,
	`match_method` text,
	`matched_announcement_id` text,
	`raw_json` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_observation_source_id_uq` ON `exchange_observation` (`source`,`source_announcement_id`);--> statement-breakpoint
CREATE INDEX `exchange_observation_date_status_idx` ON `exchange_observation` (`announce_date`,`match_status`);--> statement-breakpoint
CREATE INDEX `exchange_observation_stock_date_idx` ON `exchange_observation` (`stock_code`,`announce_date`);