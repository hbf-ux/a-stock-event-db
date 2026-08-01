CREATE INDEX `match_request_role_status_idx` ON `match_request` (`role`,`status`);--> statement-breakpoint
CREATE INDEX `match_request_created_idx` ON `match_request` (`created_at`);