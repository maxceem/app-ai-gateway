-- Hand-written first: drizzle-kit generates neither data changes nor triggers.
--
-- Every App Attest application stored when this lands measured its budget per
-- install, because that was the default when it was written. The default for
-- new applications becomes apple_account, so each existing one has install
-- written into it explicitly and keeps measuring exactly as it did; moving it
-- to apple_account is the person's call. An application whose per-user limits
-- were never written gets them written out in full as unlimited, which is what
-- reading the configuration made of them anyway.
UPDATE `app` SET `config_json` = json_set(`config_json`, '$.limits.per_user.spending.scope', 'install')
WHERE `auth_type` = 'apple_app_attest'
	AND json_type(`config_json`, '$.limits.per_user.spending') = 'object'
	AND json_type(`config_json`, '$.limits.per_user.spending.scope') IS NULL;--> statement-breakpoint
UPDATE `app` SET `config_json` = json_set(
	`config_json`,
	'$.limits.per_user',
	json('{"requests":{"per_minute":null,"per_day":null},"spending":{"monthly_usd":null,"scope":"install"}}')
)
WHERE `auth_type` = 'apple_app_attest'
	AND json_type(`config_json`, '$.limits.per_user') IS NULL;--> statement-breakpoint
-- The spend triggers name app_usage_spend, which is rebuilt below for its new
-- scope; a rename with a trigger pointing at a missing table fails, so they
-- go first and come back, with the apple_account scope, at the end.
DROP TRIGGER `app_usage_event_spend_after_insert`;--> statement-breakpoint
DROP TRIGGER `app_usage_event_spend_after_cost_update`;--> statement-breakpoint
CREATE TABLE `__new_app_rejection_event` (
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
	CONSTRAINT "rejection_events_reason_check" CHECK("reason" IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user', 'blocked_replay')),
	CONSTRAINT "rejection_events_scope_check" CHECK("scope" IS NULL OR "scope" IN ('user', 'install', 'apple_account', 'app', 'account'))
);
--> statement-breakpoint
INSERT INTO `__new_app_rejection_event`("id", "event_id", "app_id", "user_id", "api_key_id", "reason", "scope", "provider_slug", "model", "route", "endpoint_slug", "app_version", "auth_method", "latency_ms", "created_at", "install_id") SELECT "id", "event_id", "app_id", "user_id", "api_key_id", "reason", "scope", "provider_slug", "model", "route", "endpoint_slug", "app_version", "auth_method", "latency_ms", "created_at", "install_id" FROM `app_rejection_event`;--> statement-breakpoint
DROP TABLE `app_rejection_event`;--> statement-breakpoint
ALTER TABLE `__new_app_rejection_event` RENAME TO `app_rejection_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `rejection_events_event_id_unique` ON `app_rejection_event` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_created` ON `app_rejection_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_created` ON `app_rejection_event` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_app_usage_spend` (
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
--> statement-breakpoint
INSERT INTO `__new_app_usage_spend`("id", "organization_id", "app_id", "scope", "user_key", "month", "microusd") SELECT "id", "organization_id", "app_id", "scope", "user_key", "month", "microusd" FROM `app_usage_spend`;--> statement-breakpoint
DROP TABLE `app_usage_spend`;--> statement-breakpoint
ALTER TABLE `__new_app_usage_spend` RENAME TO `app_usage_spend`;--> statement-breakpoint
CREATE UNIQUE INDEX `app_usage_spend_scope_month_unique` ON `app_usage_spend` (`scope`,`app_id`,`user_key`,`month`);--> statement-breakpoint
CREATE INDEX `idx_app_usage_spend_organization` ON `app_usage_spend` (`organization_id`);--> statement-breakpoint
ALTER TABLE `app_usage_event` ADD `apple_account_id` text;--> statement-breakpoint
CREATE INDEX `idx_usage_apple_account_month` ON `app_usage_event` (`app_id`,`apple_account_id`,`created_at`) WHERE "app_usage_event"."apple_account_id" IS NOT NULL;--> statement-breakpoint
-- Hand-written below: the spend triggers of 0006_per_request_attest.sql,
-- recreated to keep an `apple_account` row beside the `user` and `install`
-- rows whenever an event names one. All are always written, so switching an
-- application's budget scope later finds history in any of them.
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
END;--> statement-breakpoint
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
