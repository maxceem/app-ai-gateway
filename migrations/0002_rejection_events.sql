CREATE TABLE `app_rejection_event` (
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
	CONSTRAINT "rejection_events_reason_check" CHECK("app_rejection_event"."reason" IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user')),
	CONSTRAINT "rejection_events_scope_check" CHECK("app_rejection_event"."scope" IS NULL OR "app_rejection_event"."scope" IN ('user', 'app', 'account'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rejection_events_event_id_unique` ON `app_rejection_event` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_created` ON `app_rejection_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_created` ON `app_rejection_event` (`created_at`);--> statement-breakpoint
-- Retain only diagnostic samples still inside the 90-day window for live apps.
-- Normalize legacy SQLite and ISO timestamps to one sortable UTC ISO format.
INSERT INTO app_rejection_event
  (event_id, app_id, user_id, api_key_id, reason, scope, provider_slug,
   model, route, endpoint_slug, app_version, auth_method, latency_ms, created_at)
SELECT usage.event_id, usage.app_id, usage.user_id, usage.api_key_id,
       usage.status, NULL, usage.provider_slug, usage.model, usage.route,
       usage.endpoint_slug, usage.app_version, usage.auth_method,
       usage.latency_ms, strftime('%Y-%m-%dT%H:%M:%fZ', usage.created_at)
FROM app_usage_event AS usage
WHERE usage.status IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user')
  AND EXISTS (SELECT 1 FROM app WHERE app.id = usage.app_id)
  AND strftime('%Y-%m-%dT%H:%M:%fZ', usage.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');--> statement-breakpoint
-- Old refusal rollups were accounting pollution and have no diagnostic detail.
DELETE FROM app_usage_rollup WHERE status IN
  ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user');--> statement-breakpoint
CREATE TABLE `__new_app_usage_event` (
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "usage_events_status_check" CHECK("__new_app_usage_event"."status" IN ('ok', 'provider_error'))
);
--> statement-breakpoint
INSERT INTO `__new_app_usage_event`("id", "event_id", "app_id", "organization_id", "user_id", "api_key_id", "provider_type", "provider_id", "provider_slug", "provider_gateway_id", "provider_gateway_type", "model", "route", "endpoint_slug", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd", "cost_source", "reported_cost_usd", "served_provider", "served_model", "credential_source", "model_author", "app_version", "auth_method", "status", "client_aborted", "latency_ms", "created_at") SELECT "id", "event_id", "app_id", "organization_id", "user_id", "api_key_id", "provider_type", "provider_id", "provider_slug", "provider_gateway_id", "provider_gateway_type", "model", "route", "endpoint_slug", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "cost_usd", "cost_source", "reported_cost_usd", "served_provider", "served_model", "credential_source", "model_author", "app_version", "auth_method", "status", "client_aborted", "latency_ms", "created_at" FROM `app_usage_event` WHERE status IN ('ok', 'provider_error');--> statement-breakpoint
DROP TABLE `app_usage_event`;--> statement-breakpoint
ALTER TABLE `__new_app_usage_event` RENAME TO `app_usage_event`;--> statement-breakpoint
CREATE INDEX `idx_usage_event_account_created` ON `app_usage_event` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_user_month` ON `app_usage_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_app_month` ON `app_usage_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_event_id_unique` ON `app_usage_event` (`event_id`);
--> statement-breakpoint
CREATE TRIGGER app_usage_event_owner_guard_before_insert
BEFORE INSERT ON app_usage_event
WHEN NOT EXISTS (SELECT 1 FROM mgmt_organization WHERE id = NEW.organization_id)
BEGIN
	SELECT RAISE(ABORT, 'app_usage_event organization no longer exists');
END;--> statement-breakpoint
-- Event insertion and both totals commit under D1's one write transaction.
-- INSERT OR IGNORE retries do not fire this trigger, so duplicate event ids are
-- inherently harmless without a second per-event deduplication ledger.
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
END;--> statement-breakpoint
-- Repricing changes only cost_usd. Applying the rounded per-event delta keeps
-- the aggregate equal to SUM(ROUND(event cost)) across increases and reductions
-- to zero; raw event deletion intentionally has no inverse trigger.
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
END;
