CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_keys_status_check" CHECK("api_keys"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_app` ON `api_keys` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
ALTER TABLE `apps` ADD `monthly_app_token_budget` integer
	CONSTRAINT "apps_monthly_app_token_budget_check"
	CHECK(`monthly_app_token_budget` IS NULL OR `monthly_app_token_budget` >= 0);
