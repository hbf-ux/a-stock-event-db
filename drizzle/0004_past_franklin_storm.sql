CREATE TABLE `match_request` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`organization` text NOT NULL,
	`contact_name` text NOT NULL,
	`email` text NOT NULL,
	`stock_code` text,
	`shareholder` text,
	`amount_min` real NOT NULL,
	`amount_max` real NOT NULL,
	`term_months` integer,
	`preference` text,
	`purpose` text,
	`notes` text,
	`risk_snapshot` text,
	`status` text DEFAULT 'new' NOT NULL,
	`viewer_id` text,
	`request_fingerprint` text NOT NULL,
	`consent_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_request_fingerprint_uq` ON `match_request` (`request_fingerprint`);