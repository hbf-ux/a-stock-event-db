CREATE TABLE IF NOT EXISTS `shareholder_profile` (
	`stock_code` text NOT NULL,
	`shareholder` text NOT NULL,
	`identity_type` text NOT NULL DEFAULT '股东',
	`is_controller` integer NOT NULL DEFAULT 0,
	`is_controlling_shareholder` integer NOT NULL DEFAULT 0,
	`holding_shares` real,
	`holding_ratio` text,
	`source_title` text,
	`source_url` text,
	`source_date` text,
	`confidence` real NOT NULL DEFAULT 1,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`stock_code`, `shareholder`)
);
CREATE INDEX IF NOT EXISTS `shareholder_profile_stock_idx` ON `shareholder_profile` (`stock_code`);
