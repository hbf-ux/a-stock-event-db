CREATE TABLE `billing_account` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`current_period_end` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_account_stripe_customer_id_unique` ON `billing_account` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_account_stripe_subscription_id_unique` ON `billing_account` (`stripe_subscription_id`);--> statement-breakpoint
CREATE TABLE `billing_event` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload_hash` text NOT NULL,
	`processed_at` text NOT NULL
);
