ALTER TABLE `exchange_observation` ADD `review_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `exchange_observation` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `exchange_observation` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `exchange_observation` ADD `review_note` text;