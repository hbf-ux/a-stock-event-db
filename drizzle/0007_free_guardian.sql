CREATE TABLE `match_candidate` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`capital_request_id` integer NOT NULL,
	`financing_request_id` integer NOT NULL,
	`score` integer NOT NULL,
	`reasons` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`capital_consented` integer DEFAULT false NOT NULL,
	`financing_consented` integer DEFAULT false NOT NULL,
	`capital_consented_at` text,
	`financing_consented_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_candidate_pair_uq` ON `match_candidate` (`capital_request_id`,`financing_request_id`);--> statement-breakpoint
CREATE INDEX `match_candidate_capital_status_idx` ON `match_candidate` (`capital_request_id`,`status`);--> statement-breakpoint
CREATE INDEX `match_candidate_financing_status_idx` ON `match_candidate` (`financing_request_id`,`status`);