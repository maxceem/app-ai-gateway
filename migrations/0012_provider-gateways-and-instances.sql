CREATE TABLE `provider_gateway` (
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
	CONSTRAINT "provider_gateways_type_check" CHECK("provider_gateway"."type" = 'cf_aig'),
	CONSTRAINT "provider_gateways_status_check" CHECK("provider_gateway"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_provider_gateways_organization` ON `provider_gateway` (`organization_id`);--> statement-breakpoint
-- Pre-release migration: provider rows contain no production data to preserve.
-- Recreating the table avoids pretending the old per-type gateway ciphertexts
-- can be losslessly mapped into reusable gateway entities.
DROP TABLE `provider`;--> statement-breakpoint
CREATE TABLE `provider` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`secret_blob` text,
	`secret_hint` text,
	`provider_gateway_id` text,
	`pricing_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("provider"."status" IN ('active', 'revoked')),
	CONSTRAINT "providers_type_check" CHECK("provider"."type" IN ('openai', 'anthropic', 'xai', 'gemini', 'perplexity')),
	CONSTRAINT "providers_secret_source_check" CHECK(("provider"."provider_gateway_id" IS NULL) = ("provider"."secret_blob" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_active_slug_unique` ON `provider` (`organization_id`,`slug`) WHERE "provider"."status" = 'active';--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `provider_slug` text;
