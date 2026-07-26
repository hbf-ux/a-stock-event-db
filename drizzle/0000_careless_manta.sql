CREATE TABLE `announcement` (
	`announcement_id` text PRIMARY KEY NOT NULL,
	`stock_code` text NOT NULL,
	`stock_name` text NOT NULL,
	`title` text NOT NULL,
	`announce_date` text NOT NULL,
	`pdf_url` text,
	`r2_key` text,
	`source` text NOT NULL,
	`crawl_time` text NOT NULL,
	`md5` text NOT NULL,
	`sha256` text,
	`parse_status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_md5_uq` ON `announcement` (`md5`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`announcement_id` text NOT NULL,
	`stock_code` text NOT NULL,
	`stock_name` text NOT NULL,
	`shareholder` text NOT NULL,
	`pledgee` text NOT NULL,
	`pledge_amount` real NOT NULL,
	`pledge_amount_text` text NOT NULL,
	`pledge_ratio` text,
	`total_ratio` text,
	`start_date` text,
	`end_date` text,
	`purpose` text,
	`type` text NOT NULL,
	`announce_date` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`parser_version` text NOT NULL,
	`parsed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pledge_announcement_shareholder_uq` ON `pledge` (`announcement_id`,`shareholder`,`type`);--> statement-breakpoint
CREATE TABLE `review_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`announcement_id` text NOT NULL,
	`event_type` text NOT NULL,
	`reason` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`reviewer` text,
	`resolution` text
);
--> statement-breakpoint
CREATE TABLE `stock_info` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`exchange` text NOT NULL,
	`industry` text,
	`list_date` text,
	`status` text DEFAULT '上市' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`announcements_found` integer DEFAULT 0 NOT NULL,
	`events_created` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`message` text
);
