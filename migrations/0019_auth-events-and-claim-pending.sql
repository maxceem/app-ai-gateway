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
ALTER TABLE `app_user` ADD `claim_pending_since` text;