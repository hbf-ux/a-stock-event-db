ALTER TABLE `announcement` ADD `parse_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `announcement` ADD `last_error` text;