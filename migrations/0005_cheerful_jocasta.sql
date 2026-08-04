PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`route` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`app_version` text,
	`auth_method` text,
	`status` text NOT NULL,
	`latency_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "usage_events_status_check" CHECK("__new_usage_events"."status" IN ('ok', 'provider_error', 'blocked_rate', 'blocked_budget', 'blocked_user'))
);
--> statement-breakpoint
-- Rows without a known cost predate the priced-model requirement and are not
-- valid accounting records. Deliberately leave them behind during the rebuild.
INSERT INTO `__new_usage_events`("id", "app_id", "user_id", "provider", "model", "route", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd", "app_version", "auth_method", "status", "latency_ms", "created_at") SELECT "id", "app_id", "user_id", "provider", "model", "route", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd", "app_version", "auth_method", "status", "latency_ms", "created_at" FROM `usage_events` WHERE "cost_usd" IS NOT NULL;--> statement-breakpoint
DROP TABLE `usage_events`;--> statement-breakpoint
ALTER TABLE `__new_usage_events` RENAME TO `usage_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_usage_user_month` ON `usage_events` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_app_month` ON `usage_events` (`app_id`,`created_at`);
