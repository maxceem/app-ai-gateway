CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`apple_team_id` text,
	`apple_bundle_id` text,
	`auth_config_json` text NOT NULL,
	`proxy_config_json` text NOT NULL,
	`limits_json` text,
	`monthly_token_budget` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "apps_monthly_token_budget_check" CHECK("apps"."monthly_token_budget" IS NULL OR "apps"."monthly_token_budget" >= 0),
	CONSTRAINT "apps_status_check" CHECK("apps"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_auth_challenges_expiry` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
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
	`cost_usd` real,
	`app_version` text,
	`auth_method` text,
	`status` text NOT NULL,
	`latency_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "usage_events_status_check" CHECK("usage_events"."status" IN ('ok', 'provider_error', 'blocked_rate', 'blocked_budget', 'blocked_user'))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_user_month` ON `usage_events` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_app_month` ON `usage_events` (`app_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`app_id` text NOT NULL,
	`id` text NOT NULL,
	`attest_key_id` text,
	`attest_public_key` text,
	`attest_counter` integer DEFAULT 0 NOT NULL,
	`attest_env` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text,
	PRIMARY KEY(`app_id`, `id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_status_check" CHECK("users"."status" IN ('active', 'blocked'))
);
