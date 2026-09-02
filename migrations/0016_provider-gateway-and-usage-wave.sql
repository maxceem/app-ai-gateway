-- One wave, two rebuilds. Widening a CHECK is a table rebuild in SQLite, so
-- `provider_gateway` (type union) and `provider` (type union plus the new
-- `gateway_route_json`) are each rebuilt exactly once here rather than once per
-- feature. Everything `app_usage_event` gains is a plain nullable ADD COLUMN:
-- that table is the largest one a deployment has, and it must never be rebuilt.
--
-- D1 wraps a migration in a transaction, where PRAGMA foreign_keys is a no-op
-- (see 0011). Deferring is what actually lets `provider_gateway` be dropped
-- while `provider` rows still reference it; the constraints are rechecked at
-- commit, by which point both renames have restored every referenced row.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`secret_blob` text,
	`secret_hint` text,
	`provider_gateway_id` text,
	`gateway_route_json` text,
	`pricing_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("__new_provider"."status" IN ('active', 'revoked')),
	CONSTRAINT "providers_type_check" CHECK("__new_provider"."type" IN (
        'openai', 'anthropic', 'xai', 'gemini', 'perplexity',
        'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'openrouter',
        'cerebras', 'moonshot', 'huggingface', 'baseten', 'bytedance'
      )),
	CONSTRAINT "providers_secret_source_check" CHECK(("__new_provider"."provider_gateway_id" IS NULL) = ("__new_provider"."secret_blob" IS NOT NULL))
);
--> statement-breakpoint
-- `gateway_route_json` is new here, so it is named in neither list: SQLite
-- resolves a double-quoted name the source table lacks as a string *literal*,
-- which would fill the column with its own name instead of NULL.
INSERT INTO `__new_provider`("id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "pricing_json", "status", "created_by", "created_at", "updated_at") SELECT "id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "pricing_json", "status", "created_by", "created_at", "updated_at" FROM `provider`;--> statement-breakpoint
DROP TABLE `provider`;--> statement-breakpoint
ALTER TABLE `__new_provider` RENAME TO `provider`;--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_active_slug_unique` ON `provider` (`organization_id`,`slug`) WHERE "provider"."status" = 'active';--> statement-breakpoint
CREATE TABLE `__new_provider_gateway` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`secret_blob` text NOT NULL,
	`secret_hint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_gateways_type_check" CHECK("__new_provider_gateway"."type" IN ('cf_aig', 'vercel')),
	CONSTRAINT "provider_gateways_status_check" CHECK("__new_provider_gateway"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_provider_gateway`("id", "organization_id", "type", "name", "config_json", "secret_blob", "secret_hint", "status", "created_by", "created_at", "updated_at") SELECT "id", "organization_id", "type", "name", "config_json", "secret_blob", "secret_hint", "status", "created_by", "created_at", "updated_at" FROM `provider_gateway`;--> statement-breakpoint
DROP TABLE `provider_gateway`;--> statement-breakpoint
ALTER TABLE `__new_provider_gateway` RENAME TO `provider_gateway`;--> statement-breakpoint
CREATE INDEX `idx_provider_gateways_organization` ON `provider_gateway` (`organization_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
-- Additive and unconstrained, for the same reason `cost_source` was in 0015:
-- new gateway types, credential sources and authors must be new values, never
-- another rebuild of the usage table. `provider_gateway_id` is deliberately not
-- a foreign key, matching `provider_id`: deleting a gateway must not take the
-- history of what it served with it.
ALTER TABLE `app_usage_event` ADD `provider_gateway_id` text;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `provider_gateway_type` text;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `reported_cost_usd` real;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `served_provider` text;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `served_model` text;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `credential_source` text;--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `model_author` text;