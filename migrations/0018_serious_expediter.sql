PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE `provider` SET `status` = 'disabled' WHERE `status` = 'revoked';--> statement-breakpoint
CREATE TABLE `__new_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`secret_blob` text,
	`secret_hint` text,
	`provider_gateway_id` text,
	`base_url` text,
	`gateway_route_json` text,
	`pricing_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `console_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("__new_provider"."status" IN ('active', 'disabled')),
	CONSTRAINT "providers_type_check" CHECK("__new_provider"."type" IN (
        'openai', 'anthropic', 'xai', 'gemini', 'perplexity',
        'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'openrouter',
        'cerebras', 'moonshot', 'huggingface', 'baseten', 'bytedance'
      )),
	CONSTRAINT "providers_secret_source_check" CHECK(("__new_provider"."provider_gateway_id" IS NULL) = ("__new_provider"."secret_blob" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_provider`("id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "base_url", "gateway_route_json", "pricing_json", "status", "created_by", "created_at", "updated_at") SELECT "id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "base_url", "gateway_route_json", "pricing_json", "status", "created_by", "created_at", "updated_at" FROM `provider`;--> statement-breakpoint
DROP TABLE `provider`;--> statement-breakpoint
ALTER TABLE `__new_provider` RENAME TO `provider`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_slug_unique` ON `provider` (`organization_id`,`slug`);