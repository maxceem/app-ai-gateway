CREATE TABLE `app` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "apps_status_check" CHECK("app"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `idx_apps_organization_id` ON `app` (`organization_id`);--> statement-breakpoint
CREATE TABLE `app_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_keys_status_check" CHECK("app_api_key"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_app` ON `app_api_key` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `app_api_key` (`key_hash`);--> statement-breakpoint
CREATE TABLE `app_auth_challenge` (
	`challenge` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_auth_challenges_expiry` ON `app_auth_challenge` (`expires_at`);--> statement-breakpoint
CREATE TABLE `app_auth_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text,
	`app_id` text NOT NULL,
	`user_id` text,
	`event` text NOT NULL,
	`auth_method` text,
	`outcome` text NOT NULL,
	`reason` text,
	`app_version` text,
	`latency_ms` integer,
	`claim_delay_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_events_app_created` ON `app_auth_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_events_app_user_created` ON `app_auth_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_events_event_id_unique` ON `app_auth_event` (`event_id`);--> statement-breakpoint
CREATE TABLE `app_usage_event` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` text,
	`app_id` text NOT NULL,
	`organization_id` text DEFAULT '' NOT NULL,
	`user_id` text,
	`api_key_id` text,
	`provider_type` text NOT NULL,
	`provider_id` text,
	`provider_slug` text,
	`provider_gateway_id` text,
	`provider_gateway_type` text,
	`model` text NOT NULL,
	`route` text NOT NULL,
	`endpoint_slug` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_source` text,
	`reported_cost_usd` real,
	`served_provider` text,
	`served_model` text,
	`credential_source` text,
	`model_author` text,
	`app_version` text,
	`auth_method` text,
	`status` text NOT NULL,
	`client_aborted` integer,
	`latency_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "usage_events_status_check" CHECK("app_usage_event"."status" IN ('ok', 'provider_error', 'blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user'))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_event_account_created` ON `app_usage_event` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_user_month` ON `app_usage_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_app_month` ON `app_usage_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_event_id_unique` ON `app_usage_event` (`event_id`);--> statement-breakpoint
CREATE TABLE `app_usage_rollup` (
	`id` integer PRIMARY KEY NOT NULL,
	`grain` text NOT NULL,
	`bucket` text NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`provider_type` text NOT NULL,
	`status` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_rollup_key` ON `app_usage_rollup` (`organization_id`,`grain`,`bucket`,`app_id`,`model`,`provider_type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_usage_rollup_account_bucket` ON `app_usage_rollup` (`organization_id`,`grain`,`bucket`);--> statement-breakpoint
CREATE INDEX `idx_usage_rollup_app_bucket` ON `app_usage_rollup` (`app_id`,`grain`,`bucket`);--> statement-breakpoint
CREATE TABLE `app_user` (
	`app_id` text NOT NULL,
	`id` text NOT NULL,
	`attest_key_id` text,
	`attest_public_key` text,
	`attest_counter` integer DEFAULT 0 NOT NULL,
	`attest_env` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text,
	`claim_pending_since` text,
	PRIMARY KEY(`app_id`, `id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_status_check" CHECK("app_user"."status" IN ('active', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE `mgmt_user_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mgmt_idx_account_user_id` ON `mgmt_user_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_idx_account_provider_account` ON `mgmt_user_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `mgmt_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_api_key_token_hash_unique` ON `mgmt_api_key` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_api_key_user_id` ON `mgmt_api_key` (`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_api_key_organization_id` ON `mgmt_api_key` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mgmt_handoff` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`request_json` text NOT NULL,
	`organization_id` text NOT NULL,
	`initiating_user_id` text NOT NULL,
	`initiating_credential_id` text NOT NULL,
	`submission_proof_hash` text NOT NULL,
	`poll_proof_hash` text NOT NULL,
	`consumed_at` integer,
	`outcome` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mgmt_handoff_pending` ON `mgmt_handoff` (`organization_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `mgmt_organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mgmt_organization_user` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mgmt_organization_user_role_check" CHECK("mgmt_organization_user"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "mgmt_organization_user_status_check" CHECK("mgmt_organization_user"."status" in ('active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_user_organization_id_user_id_unique` ON `mgmt_organization_user` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_user_user_id` ON `mgmt_organization_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_user_organization_id` ON `mgmt_organization_user` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mgmt_resource_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text,
	`initiating_user_id` text,
	`initiating_credential_id` text,
	`proof_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`outcome` text,
	`protected_credential` text,
	`protected_credential_expires_at` integer,
	`consumed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_mgmt_resource_receipt_organization` ON `mgmt_resource_receipt` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mgmt_user_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_idx_session_token` ON `mgmt_user_session` (`token`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_session_user_id` ON `mgmt_user_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `mgmt_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`kind` text DEFAULT 'human' NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mgmt_user_kind_email_check" CHECK(("mgmt_user"."kind" = 'human' and "mgmt_user"."email" is not null) or ("mgmt_user"."kind" = 'service' and "mgmt_user"."email" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_idx_user_email` ON `mgmt_user` ("email" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `mgmt_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `mgmt_idx_verification_identifier` ON `mgmt_verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `provider` (
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
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("provider"."status" IN ('active', 'disabled')),
	CONSTRAINT "providers_type_check" CHECK("provider"."type" IN (
        'openai', 'anthropic', 'xai', 'gemini', 'perplexity',
        'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'openrouter',
        'cerebras', 'moonshot', 'huggingface', 'baseten', 'bytedance'
      )),
	CONSTRAINT "providers_secret_source_check" CHECK(("provider"."provider_gateway_id" IS NULL) = ("provider"."secret_blob" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_slug_unique` ON `provider` (`organization_id`,`slug`);--> statement-breakpoint
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
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_gateways_type_check" CHECK("provider_gateway"."type" IN ('cf_aig', 'vercel')),
	CONSTRAINT "provider_gateways_status_check" CHECK("provider_gateway"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_provider_gateways_organization` ON `provider_gateway` (`organization_id`);