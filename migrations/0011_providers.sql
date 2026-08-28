-- Requires every app row to already have an organization: org-less apps have no
-- key source once credentials are per-organization. Run `pnpm run migrate-to-orgs`
-- first if this migration fails on the NOT NULL rebuild below.
ALTER TABLE `app_usage_event` RENAME COLUMN "provider" TO "provider_type";--> statement-breakpoint
CREATE TABLE `provider` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`secret_blob` text NOT NULL,
	`secret_hint` text NOT NULL,
	`gateway` text,
	`gateway_config_json` text,
	`pricing_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("provider"."status" IN ('active', 'revoked')),
	CONSTRAINT "providers_type_check" CHECK("provider"."type" IN ('openai', 'anthropic', 'xai', 'gemini', 'perplexity')),
	CONSTRAINT "providers_gateway_check" CHECK("provider"."gateway" IS NULL OR "provider"."gateway" = 'cf_aig')
);
--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_active_type_unique` ON `provider` (`organization_id`,`type`) WHERE "provider"."status" = 'active';--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `provider_id` text;--> statement-breakpoint
-- D1 wraps a migration in a transaction, where PRAGMA foreign_keys is a no-op.
-- Deferring instead is what actually lets the rebuild drop `app` while
-- app_api_key, app_user and app_auth_challenge still reference it; the
-- constraints are rechecked at commit, by which point the rename has restored
-- every referenced row.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_app` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "apps_status_check" CHECK("__new_app"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_app`("id", "organization_id", "name", "config_json", "status", "created_at", "updated_at") SELECT "id", "organization_id", "name", "config_json", "status", "created_at", "updated_at" FROM `app`;--> statement-breakpoint
DROP TABLE `app`;--> statement-breakpoint
ALTER TABLE `__new_app` RENAME TO `app`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE INDEX `idx_apps_organization_id` ON `app` (`organization_id`);