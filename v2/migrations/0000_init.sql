CREATE TABLE `account_activation` (
	`account_id` text PRIMARY KEY NOT NULL,
	`activated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_status" CHECK("app"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `app_account` ON `app` (`account_id`);--> statement-breakpoint
CREATE TABLE `app_attest_key` (
	`app_id` text NOT NULL,
	`key_id` text NOT NULL,
	`public_key` text NOT NULL,
	`environment` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `key_id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_attest_key_environment" CHECK("app_attest_key"."environment" IN ('production', 'development'))
);
--> statement-breakpoint
CREATE INDEX `app_attest_key_user` ON `app_attest_key` (`app_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `app_end_user` (
	`app_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	PRIMARY KEY(`app_id`, `id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_end_user_status" CHECK("app_end_user"."status" IN ('active', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE `app_key` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_key_status" CHECK("app_key"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `app_key_app` ON `app_key` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_key_hash` ON `app_key` (`key_hash`);--> statement-breakpoint
CREATE TABLE `budget_day` (
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`day` text NOT NULL,
	`cost_nano` integer DEFAULT 0 NOT NULL,
	`session_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`app_id`, `scope`, `scope_id`, `day`),
	CONSTRAINT "budget_day_scope" CHECK("budget_day"."scope" IN ('app', 'user', 'install', 'apple_account'))
);
--> statement-breakpoint
CREATE TABLE `charge` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`end_user_id` text,
	`install_id` text,
	`apple_account_id` text,
	`app_key_id` text,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`seq` integer,
	`provider_type` text NOT NULL,
	`provider_connection_id` text,
	`operation` text NOT NULL,
	`preset` text,
	`model` text,
	`status` text NOT NULL,
	`http_status` integer,
	`error_code` text,
	`cost_nano` integer,
	`measured` text NOT NULL,
	`price_source` text NOT NULL,
	`price_is_estimate` integer DEFAULT false NOT NULL,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`cache_write_tokens` integer,
	`output_tokens` integer,
	`unit` text,
	`units` integer,
	`measures_json` text NOT NULL,
	`rates_json` text,
	`session_ms` integer,
	`correction_kind` text,
	`corrects_charge_id` text,
	`latency_ms` integer,
	`app_version` text,
	`auth_method` text,
	`client_trace_id` text,
	`used_at` integer NOT NULL,
	`usage_day` text NOT NULL,
	`written_at` integer NOT NULL,
	CONSTRAINT "charge_kind" CHECK("charge"."kind" IN ('attempt', 'slice', 'estimate', 'correction')),
	CONSTRAINT "charge_owner_type" CHECK("charge"."owner_type" IN ('call', 'session', 'job')),
	CONSTRAINT "charge_measured" CHECK("charge"."measured" IN ('complete', 'partial', 'estimated', 'pending')),
	CONSTRAINT "charge_price_source" CHECK("charge"."price_source" IN ('provider_usd', 'list_rate', 'customer_rate', 'unresolved', 'not_priced')),
	CONSTRAINT "charge_correction" CHECK(("charge"."kind" = 'correction') = ("charge"."correction_kind" IS NOT NULL)
        AND ("charge"."correction_kind" IS NULL OR "charge"."correction_kind" IN ('units', 'dollars', 'pricing'))),
	CONSTRAINT "charge_corrects_only_corrections" CHECK("charge"."corrects_charge_id" IS NULL OR "charge"."kind" = 'correction'),
	CONSTRAINT "charge_session_ms" CHECK("charge"."session_ms" IS NULL OR "charge"."kind" = 'slice'),
	CONSTRAINT "charge_usage_day" CHECK(length("charge"."usage_day") = 10)
);
--> statement-breakpoint
CREATE INDEX `charge_app_used` ON `charge` (`app_id`,`used_at`);--> statement-breakpoint
CREATE INDEX `charge_account_used` ON `charge` (`account_id`,`used_at`);--> statement-breakpoint
CREATE INDEX `charge_owner` ON `charge` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `charge_corrects` ON `charge` (`corrects_charge_id`);--> statement-breakpoint
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
	`source` text DEFAULT 'console' NOT NULL,
	`label` text,
	`grant` text DEFAULT 'manage' NOT NULL,
	`client_id` text,
	`resource` text,
	`credential_type` text DEFAULT 'apiKey' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_api_key_token_hash_unique` ON `mgmt_api_key` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_api_key_user_id` ON `mgmt_api_key` (`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_api_key_organization_id` ON `mgmt_api_key` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mgmt_oauth_token` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`generation` integer NOT NULL,
	`access_token_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`rotated_at` integer,
	`sealed_response` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `mgmt_api_key`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_oauth_token_access_token_hash_unique` ON `mgmt_oauth_token` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_oauth_token_refresh_token_hash_unique` ON `mgmt_oauth_token` (`refresh_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_oauth_token_api_key_id_generation_unique` ON `mgmt_oauth_token` (`api_key_id`,`generation`);--> statement-breakpoint
CREATE TABLE `mgmt_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`opener_user_id` text,
	`opener_credential_id` text,
	`organization_id` text,
	`opener_key` text,
	`request_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`browser_proof_hash` text,
	`user_code_hash` text,
	`user_code_sealed` text,
	`client_label` text,
	`client_meta` text,
	`loopback_redirect` text,
	`redeem_code_hash` text,
	`outcome` text,
	`sealed_outcome` text,
	`sealed_until` integer,
	`decided_by_user_id` text,
	`payload` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`retain_until` integer NOT NULL,
	`execution_claim` text,
	FOREIGN KEY (`opener_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mgmt_operation_state_check" CHECK("mgmt_operation"."state" in ('pending', 'completed', 'denied', 'expired', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_operation_poll_token_hash_unique` ON `mgmt_operation` (`poll_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_operation_user_code_pending_unique` ON `mgmt_operation` (`user_code_hash`) WHERE "mgmt_operation"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `mgmt_idx_operation_organization` ON `mgmt_operation` (`organization_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_operation_opener` ON `mgmt_operation` (`opener_key`,`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_operation_state_expires` ON `mgmt_operation` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_operation_sealed_until` ON `mgmt_operation` (`sealed_until`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_operation_retain_until` ON `mgmt_operation` (`retain_until`);--> statement-breakpoint
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
CREATE TABLE `mgmt_organization_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`response` text,
	`responded_at` text,
	`responded_by_user_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`responded_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mgmt_organization_invitation_role_check" CHECK("mgmt_organization_invitation"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "mgmt_organization_invitation_response_check" CHECK("mgmt_organization_invitation"."response" is null or "mgmt_organization_invitation"."response" in ('accepted', 'declined', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_invitation_token_hash_unique` ON `mgmt_organization_invitation` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_invitation_open_unique` ON `mgmt_organization_invitation` (`organization_id`,`email`) WHERE "mgmt_organization_invitation"."response" is null;--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_invitation_email` ON `mgmt_organization_invitation` (`email`);--> statement-breakpoint
CREATE TABLE `mgmt_organization_user` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` text NOT NULL,
	`last_active_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mgmt_organization_user_role_check" CHECK("mgmt_organization_user"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "mgmt_organization_user_status_check" CHECK("mgmt_organization_user"."status" in ('active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_user_organization_id_user_id_unique` ON `mgmt_organization_user` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_user_user_id` ON `mgmt_organization_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_user_organization_id` ON `mgmt_organization_user` (`organization_id`);--> statement-breakpoint
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
CREATE TABLE `open_work` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`charge_id` text,
	`detail_json` text,
	`due_at` integer NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "open_work_kind" CHECK("open_work"."kind" IN ('provider_lookup', 'unresolved', 'stale_session', 'job_check')),
	CONSTRAINT "open_work_owner_type" CHECK("open_work"."owner_type" IN ('call', 'session', 'job'))
);
--> statement-breakpoint
CREATE INDEX `open_work_due` ON `open_work` (`due_at`);--> statement-breakpoint
CREATE INDEX `open_work_owner` ON `open_work` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `provider_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`secret_blob` text,
	`secret_hint` text,
	`base_url` text,
	`cloudflare_gateway_json` text,
	`rates_json` text,
	`passthrough_json` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_connection_status" CHECK("provider_connection"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connection_slug` ON `provider_connection` (`account_id`,`slug`);--> statement-breakpoint
CREATE TABLE `usage_day` (
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`day` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`model` text NOT NULL,
	`outcome` text NOT NULL,
	`unit` text NOT NULL,
	`charges` integer DEFAULT 0 NOT NULL,
	`unpriced_charges` integer DEFAULT 0 NOT NULL,
	`cost_nano` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`session_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`app_id`, `day`, `provider_type`, `provider_connection_id`, `model`, `outcome`, `unit`),
	CONSTRAINT "usage_day_outcome" CHECK("usage_day"."outcome" IN ('ok', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `usage_day_account` ON `usage_day` (`account_id`,`day`);