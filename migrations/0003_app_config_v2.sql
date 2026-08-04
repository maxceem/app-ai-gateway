-- App configuration v2 is an intentional clean break. Tenant-owned app rows,
-- users, challenges, and credentials are disposable and must be recreated.
-- Usage events remain the immutable accounting record.
DROP TABLE `auth_challenges`;
--> statement-breakpoint
DROP TABLE `api_keys`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
DROP TABLE `apps`;
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "apps_status_check" CHECK("apps"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
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
CREATE INDEX `idx_api_keys_app` ON `api_keys` (`app_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_auth_challenges_expiry` ON `auth_challenges` (`expires_at`);
