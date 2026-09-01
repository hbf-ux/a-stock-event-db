CREATE TABLE `daily_report` (
	`date` text PRIMARY KEY NOT NULL,
	`cutoff_at` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`announcement_count` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`company_count` integer DEFAULT 0 NOT NULL,
	`reconciliation_status` text DEFAULT 'pending' NOT NULL,
	`report_version` integer DEFAULT 1 NOT NULL,
	`published_at` text,
	`published_by` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `daily_report_status_date_idx` ON `daily_report` (`status`,`date`);