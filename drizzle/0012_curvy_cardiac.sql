ALTER TABLE `pledge` ADD `verification_status` text DEFAULT 'rules_validated' NOT NULL;--> statement-breakpoint
ALTER TABLE `pledge` ADD `verified_at` text;--> statement-breakpoint
ALTER TABLE `pledge` ADD `verified_by` text;--> statement-breakpoint
ALTER TABLE `pledge` ADD `evidence_json` text DEFAULT '{}' NOT NULL;