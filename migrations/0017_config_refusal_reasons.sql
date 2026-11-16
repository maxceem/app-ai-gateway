PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "rejection_events_reason_check" CHECK("__new_app_rejection_event"."reason" IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user', 'blocked_replay', 'path_not_allowed', 'model_not_allowed', 'provider_not_configured', 'provider_disabled', 'pricing_not_configured', 'max_output_tokens_exceeded', 'api_style_not_supported', 'payload_too_large', 'endpoint_not_found')),
	CONSTRAINT "rejection_events_scope_check" CHECK("__new_app_rejection_event"."scope" IS NULL OR "__new_app_rejection_event"."scope" IN ('user', 'install', 'apple_account', 'app', 'account'))
);
--> statement-breakpoint
INSERT INTO `__new_app_rejection_event`("id", "event_id", "app_id", "user_id", "api_key_id", "reason", "scope", "provider_slug", "model", "route", "endpoint_slug", "app_version", "auth_method", "latency_ms", "created_at", "install_id") SELECT "id", "event_id", "app_id", "user_id", "api_key_id", "reason", "scope", "provider_slug", "model", "route", "endpoint_slug", "app_version", "auth_method", "latency_ms", "created_at", "install_id" FROM `app_rejection_event`;--> statement-breakpoint
DROP TABLE `app_rejection_event`;--> statement-breakpoint
ALTER TABLE `__new_app_rejection_event` RENAME TO `app_rejection_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `rejection_events_event_id_unique` ON `app_rejection_event` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_created` ON `app_rejection_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_rejection_events_created` ON `app_rejection_event` (`created_at`);