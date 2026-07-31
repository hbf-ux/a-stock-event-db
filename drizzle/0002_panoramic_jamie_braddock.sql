-- Cloud-synced watchlist is safe to re-run against existing D1 databases.
CREATE TABLE IF NOT EXISTS `user_watchlist` (
	`user_id` text NOT NULL,
	`stock_code` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `stock_code`)
);
