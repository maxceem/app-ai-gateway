PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `app` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`auth_type` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "apps_status_check" CHECK("app"."status" IN ('active', 'disabled'))
);
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
CREATE TABLE `app_auth_challenge` (
	`challenge` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`expires_at` text NOT NULL, `app_version` text, `client_sdk` text, `network_asn` integer, `network_name` text, `attempted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `app_auth_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
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
, `client_sdk` text, `network_asn` integer, `network_name` text);
CREATE TABLE `app_usage_event` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL, `modality_tokens` text, `install_id` text, `token_variants` text, `client_trace_id` text, `apple_account_id` text, `service_mode` text, `error` text,
	CONSTRAINT "usage_events_status_check" CHECK("app_usage_event"."status" IN ('ok', 'provider_error'))
);
CREATE TABLE `app_usage_rollup` (
	`id` integer PRIMARY KEY NOT NULL,
	`grain` text NOT NULL,
	`bucket` text NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
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
	`revoked_at` integer, `source` text DEFAULT 'console' NOT NULL, `label` text, `grant` text DEFAULT 'manage' NOT NULL, `client_id` text, `resource` text, `credential_type` text DEFAULT 'apiKey' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `mgmt_organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `mgmt_organization_user` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` text NOT NULL, `last_active_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mgmt_organization_user_role_check" CHECK("mgmt_organization_user"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "mgmt_organization_user_status_check" CHECK("mgmt_organization_user"."status" in ('active'))
);
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
CREATE TABLE `mgmt_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
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
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("provider"."status" IN ('active', 'disabled')),
	CONSTRAINT "providers_secret_source_check" CHECK(("provider"."provider_gateway_id" IS NULL) = ("provider"."secret_blob" IS NOT NULL))
);
CREATE TABLE `provider_gateway` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`secret_blob` text NOT NULL,
	`secret_hint` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_gateways_status_check" CHECK("provider_gateway"."status" IN ('active', 'revoked'))
);
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
	`retain_until` integer NOT NULL, `execution_claim` text,
	FOREIGN KEY (`opener_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mgmt_operation_state_check" CHECK("mgmt_operation"."state" in ('pending', 'completed', 'denied', 'expired', 'retired'))
);
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
CREATE TABLE `app_attest_key` (
	`app_id` text NOT NULL,
	`key_id` text NOT NULL,
	`public_key` text NOT NULL,
	`environment` text NOT NULL,
	`user_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`app_id`, `key_id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE IF NOT EXISTS "app_user" (
	`app_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text,
	`claim_pending_since` text,
	PRIMARY KEY(`app_id`, `id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_status_check" CHECK("status" IN ('active', 'blocked'))
);
CREATE TABLE `account_activation` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`activated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
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
CREATE TABLE `app_usage_day` (
	`app_id` text NOT NULL,
	`day` text NOT NULL,
	`organization_id` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`errors` integer NOT NULL,
	PRIMARY KEY(`app_id`, `day`)
);
CREATE TABLE `app_usage_day_window` (
	`id` integer PRIMARY KEY NOT NULL,
	`sealed_from` text NOT NULL,
	`sealed_until` text NOT NULL,
	CONSTRAINT "app_usage_day_window_singleton_check" CHECK("app_usage_day_window"."id" = 1),
	CONSTRAINT "app_usage_day_window_order_check" CHECK("app_usage_day_window"."sealed_from" <= "app_usage_day_window"."sealed_until")
);
CREATE TABLE IF NOT EXISTS "app_usage_spend" (
	`id` integer PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`user_key` text NOT NULL,
	`month` text NOT NULL,
	`microusd` integer NOT NULL,
	CONSTRAINT "app_usage_spend_scope_check" CHECK("scope" IN ('app', 'user', 'install', 'apple_account')),
	CONSTRAINT "app_usage_spend_month_check" CHECK("month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "app_usage_spend_microusd_check" CHECK("microusd" >= 0)
);
CREATE TABLE IF NOT EXISTS "app_rejection_event" (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text,
	`api_key_id` text,
	`reason` text NOT NULL,
	`scope` text,
	`provider_slug` text,
	`model` text,
	`route` text,
	`endpoint_slug` text,
	`app_version` text,
	`auth_method` text,
	`latency_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`install_id` text,
	CONSTRAINT "rejection_events_reason_check" CHECK("app_rejection_event"."reason" IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user', 'blocked_replay', 'path_not_allowed', 'model_not_allowed', 'provider_not_configured', 'provider_disabled', 'pricing_not_configured', 'max_output_tokens_exceeded', 'api_style_not_supported', 'payload_too_large', 'endpoint_not_found')),
	CONSTRAINT "rejection_events_scope_check" CHECK("app_rejection_event"."scope" IS NULL OR "app_rejection_event"."scope" IN ('user', 'install', 'apple_account', 'app', 'account'))
);
DELETE FROM sqlite_sequence;
CREATE INDEX `idx_apps_organization_id` ON `app` (`organization_id`);
CREATE INDEX `idx_api_keys_app` ON `app_api_key` (`app_id`);
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `app_api_key` (`key_hash`);
CREATE INDEX `idx_auth_challenges_expiry` ON `app_auth_challenge` (`expires_at`);
CREATE INDEX `idx_auth_events_app_created` ON `app_auth_event` (`app_id`,`created_at`);
CREATE INDEX `idx_auth_events_app_user_created` ON `app_auth_event` (`app_id`,`user_id`,`created_at`);
CREATE UNIQUE INDEX `auth_events_event_id_unique` ON `app_auth_event` (`event_id`);
CREATE INDEX `idx_usage_event_account_created` ON `app_usage_event` (`organization_id`,`created_at`);
CREATE INDEX `idx_usage_user_month` ON `app_usage_event` (`app_id`,`user_id`,`created_at`);
CREATE INDEX `idx_usage_app_month` ON `app_usage_event` (`app_id`,`created_at`);
CREATE UNIQUE INDEX `usage_events_event_id_unique` ON `app_usage_event` (`event_id`);
CREATE UNIQUE INDEX `usage_rollup_key` ON `app_usage_rollup` (`organization_id`,`grain`,`bucket`,`app_id`,`model`,`provider_type`,`status`);
CREATE INDEX `idx_usage_rollup_account_bucket` ON `app_usage_rollup` (`organization_id`,`grain`,`bucket`);
CREATE INDEX `idx_usage_rollup_app_bucket` ON `app_usage_rollup` (`app_id`,`grain`,`bucket`);
CREATE UNIQUE INDEX `mgmt_api_key_token_hash_unique` ON `mgmt_api_key` (`token_hash`);
CREATE INDEX `mgmt_idx_api_key_user_id` ON `mgmt_api_key` (`user_id`);
CREATE INDEX `mgmt_idx_api_key_organization_id` ON `mgmt_api_key` (`organization_id`);
CREATE UNIQUE INDEX `mgmt_organization_user_organization_id_user_id_unique` ON `mgmt_organization_user` (`organization_id`,`user_id`);
CREATE INDEX `mgmt_idx_organization_user_user_id` ON `mgmt_organization_user` (`user_id`);
CREATE INDEX `mgmt_idx_organization_user_organization_id` ON `mgmt_organization_user` (`organization_id`);
CREATE UNIQUE INDEX `mgmt_idx_user_email` ON `mgmt_user` ("email" COLLATE NOCASE);
CREATE INDEX `mgmt_idx_account_user_id` ON `mgmt_user_account` (`user_id`);
CREATE UNIQUE INDEX `mgmt_idx_account_provider_account` ON `mgmt_user_account` (`provider_id`,`account_id`);
CREATE UNIQUE INDEX `mgmt_idx_session_token` ON `mgmt_user_session` (`token`);
CREATE INDEX `mgmt_idx_session_user_id` ON `mgmt_user_session` (`user_id`);
CREATE INDEX `mgmt_idx_verification_identifier` ON `mgmt_verification` (`identifier`);
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);
CREATE UNIQUE INDEX `providers_slug_unique` ON `provider` (`organization_id`,`slug`);
CREATE INDEX `idx_provider_gateways_organization` ON `provider_gateway` (`organization_id`);
CREATE UNIQUE INDEX `mgmt_operation_poll_token_hash_unique` ON `mgmt_operation` (`poll_token_hash`);
CREATE UNIQUE INDEX `mgmt_operation_user_code_pending_unique` ON `mgmt_operation` (`user_code_hash`) WHERE "mgmt_operation"."state" = 'pending';
CREATE INDEX `mgmt_idx_operation_organization` ON `mgmt_operation` (`organization_id`,`state`,`expires_at`);
CREATE INDEX `mgmt_idx_operation_opener` ON `mgmt_operation` (`opener_key`,`state`,`expires_at`);
CREATE INDEX `mgmt_idx_operation_state_expires` ON `mgmt_operation` (`state`,`expires_at`);
CREATE INDEX `mgmt_idx_operation_sealed_until` ON `mgmt_operation` (`sealed_until`);
CREATE INDEX `mgmt_idx_operation_retain_until` ON `mgmt_operation` (`retain_until`);
CREATE UNIQUE INDEX `mgmt_oauth_token_access_token_hash_unique` ON `mgmt_oauth_token` (`access_token_hash`);
CREATE UNIQUE INDEX `mgmt_oauth_token_refresh_token_hash_unique` ON `mgmt_oauth_token` (`refresh_token_hash`);
CREATE UNIQUE INDEX `mgmt_oauth_token_api_key_id_generation_unique` ON `mgmt_oauth_token` (`api_key_id`,`generation`);
CREATE INDEX `idx_attest_keys_app_user` ON `app_attest_key` (`app_id`,`user_id`);
CREATE INDEX `idx_usage_install_month` ON `app_usage_event` (`app_id`,`install_id`,`created_at`);
CREATE UNIQUE INDEX `mgmt_organization_invitation_token_hash_unique` ON `mgmt_organization_invitation` (`token_hash`);
CREATE UNIQUE INDEX `mgmt_organization_invitation_open_unique` ON `mgmt_organization_invitation` (`organization_id`,`email`) WHERE "mgmt_organization_invitation"."response" is null;
CREATE INDEX `mgmt_idx_organization_invitation_email` ON `mgmt_organization_invitation` (`email`);
CREATE INDEX `idx_app_usage_day_organization` ON `app_usage_day` (`organization_id`);
CREATE INDEX `idx_usage_trace` ON `app_usage_event` (`app_id`,`client_trace_id`) WHERE "app_usage_event"."client_trace_id" IS NOT NULL;
CREATE UNIQUE INDEX `app_usage_spend_scope_month_unique` ON `app_usage_spend` (`scope`,`app_id`,`user_key`,`month`);
CREATE INDEX `idx_app_usage_spend_organization` ON `app_usage_spend` (`organization_id`);
CREATE INDEX `idx_usage_apple_account_month` ON `app_usage_event` (`app_id`,`apple_account_id`,`created_at`) WHERE "app_usage_event"."apple_account_id" IS NOT NULL;
CREATE UNIQUE INDEX `rejection_events_event_id_unique` ON `app_rejection_event` (`event_id`);
CREATE INDEX `idx_rejection_events_app_created` ON `app_rejection_event` (`app_id`,`created_at`);
CREATE INDEX `idx_rejection_events_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`created_at`);
CREATE INDEX `idx_rejection_events_created` ON `app_rejection_event` (`created_at`);
CREATE TRIGGER app_usage_event_owner_guard_before_insert
BEFORE INSERT ON app_usage_event
WHEN NOT EXISTS (SELECT 1 FROM mgmt_organization WHERE id = NEW.organization_id)
BEGIN
	SELECT RAISE(ABORT, 'app_usage_event organization no longer exists');
END;
CREATE TRIGGER app_usage_day_after_insert
AFTER INSERT ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE substr(NEW.created_at, 1, 10) >= w.sealed_from
		AND substr(NEW.created_at, 1, 10) < w.sealed_until)
BEGIN
	INSERT INTO app_usage_day(
		app_id, day, organization_id, requests, input_tokens, cached_input_tokens,
		cache_write_tokens, output_tokens, cost_usd, errors
	) VALUES (
		NEW.app_id, substr(NEW.created_at, 1, 10), NEW.organization_id, 1,
		NEW.input_tokens, NEW.cached_input_tokens, NEW.cache_write_tokens,
		NEW.output_tokens, NEW.cost_usd, NEW.status = 'provider_error'
	)
	ON CONFLICT(app_id, day) DO UPDATE SET
		requests = requests + excluded.requests,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		cost_usd = cost_usd + excluded.cost_usd,
		errors = errors + excluded.errors;
END;
CREATE TRIGGER app_usage_day_after_delete
AFTER DELETE ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE substr(OLD.created_at, 1, 10) >= w.sealed_from
		AND substr(OLD.created_at, 1, 10) < w.sealed_until)
BEGIN
	UPDATE app_usage_day SET
		requests = requests - 1,
		input_tokens = input_tokens - OLD.input_tokens,
		cached_input_tokens = cached_input_tokens - OLD.cached_input_tokens,
		cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
		output_tokens = output_tokens - OLD.output_tokens,
		cost_usd = cost_usd - OLD.cost_usd,
		errors = errors - (OLD.status = 'provider_error')
	WHERE app_id = OLD.app_id AND day = substr(OLD.created_at, 1, 10);
END;
CREATE TRIGGER app_usage_day_after_update
AFTER UPDATE OF app_id, organization_id, created_at, input_tokens, cached_input_tokens,
	cache_write_tokens, output_tokens, cost_usd, status ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE (substr(OLD.created_at, 1, 10) >= w.sealed_from
			AND substr(OLD.created_at, 1, 10) < w.sealed_until)
		OR (substr(NEW.created_at, 1, 10) >= w.sealed_from
			AND substr(NEW.created_at, 1, 10) < w.sealed_until))
BEGIN
	UPDATE app_usage_day SET
		requests = requests - 1,
		input_tokens = input_tokens - OLD.input_tokens,
		cached_input_tokens = cached_input_tokens - OLD.cached_input_tokens,
		cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
		output_tokens = output_tokens - OLD.output_tokens,
		cost_usd = cost_usd - OLD.cost_usd,
		errors = errors - (OLD.status = 'provider_error')
	WHERE app_id = OLD.app_id AND day = substr(OLD.created_at, 1, 10)
		AND EXISTS (SELECT 1 FROM app_usage_day_window AS w
			WHERE substr(OLD.created_at, 1, 10) >= w.sealed_from
				AND substr(OLD.created_at, 1, 10) < w.sealed_until);

	INSERT INTO app_usage_day(
		app_id, day, organization_id, requests, input_tokens, cached_input_tokens,
		cache_write_tokens, output_tokens, cost_usd, errors
	)
	SELECT
		NEW.app_id, substr(NEW.created_at, 1, 10), NEW.organization_id, 1,
		NEW.input_tokens, NEW.cached_input_tokens, NEW.cache_write_tokens,
		NEW.output_tokens, NEW.cost_usd, NEW.status = 'provider_error'
	WHERE EXISTS (SELECT 1 FROM app_usage_day_window AS w
		WHERE substr(NEW.created_at, 1, 10) >= w.sealed_from
			AND substr(NEW.created_at, 1, 10) < w.sealed_until)
	ON CONFLICT(app_id, day) DO UPDATE SET
		requests = requests + excluded.requests,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		cost_usd = cost_usd + excluded.cost_usd,
		errors = errors + excluded.errors;
END;
CREATE TRIGGER app_usage_event_spend_after_insert
AFTER INSERT ON app_usage_event
WHEN CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0
BEGIN
	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	) VALUES (
		NEW.organization_id, NEW.app_id, 'app', '',
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	)
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		microusd = app_usage_spend.microusd + excluded.microusd;

	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'user', NEW.user_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.user_id IS NOT NULL
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		microusd = app_usage_spend.microusd + excluded.microusd;

	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'install', NEW.install_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.install_id IS NOT NULL
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		microusd = app_usage_spend.microusd + excluded.microusd;

	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'apple_account', NEW.apple_account_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.apple_account_id IS NOT NULL
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		microusd = app_usage_spend.microusd + excluded.microusd;
END;
CREATE TRIGGER app_usage_event_spend_after_cost_update
AFTER UPDATE OF cost_usd ON app_usage_event
WHEN CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	!= CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
BEGIN
	UPDATE app_usage_spend SET
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
	WHERE scope = 'app'
		AND app_id = NEW.app_id
		AND user_key = ''
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'app', '',
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;

	UPDATE app_usage_spend SET
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.user_id IS NOT NULL
		AND scope = 'user'
		AND app_id = NEW.app_id
		AND user_key = NEW.user_id
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'user', NEW.user_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.user_id IS NOT NULL
		AND CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;

	UPDATE app_usage_spend SET
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.install_id IS NOT NULL
		AND scope = 'install'
		AND app_id = NEW.app_id
		AND user_key = NEW.install_id
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'install', NEW.install_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.install_id IS NOT NULL
		AND CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;

	UPDATE app_usage_spend SET
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.apple_account_id IS NOT NULL
		AND scope = 'apple_account'
		AND app_id = NEW.app_id
		AND user_key = NEW.apple_account_id
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month, microusd
	)
	SELECT
		NEW.organization_id, NEW.app_id, 'apple_account', NEW.apple_account_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	WHERE NEW.apple_account_id IS NOT NULL
		AND CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;
END;
CREATE TRIGGER app_usage_event_error_from_status
AFTER INSERT ON app_usage_event
WHEN NEW.status = 'provider_error' AND NEW.error IS NULL
BEGIN
	UPDATE app_usage_event SET error = 'provider_error' WHERE id = NEW.id;
END;