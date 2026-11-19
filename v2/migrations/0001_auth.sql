CREATE TABLE `app_auth_challenge` (
	`challenge` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`app_version` text,
	`client_sdk` text,
	`network_asn` integer,
	`network_name` text,
	`attempted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_auth_challenge_expiry` ON `app_auth_challenge` (`expires_at`);--> statement-breakpoint
CREATE TABLE `app_auth_event` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text,
	`event` text NOT NULL,
	`auth_method` text,
	`outcome` text NOT NULL,
	`reason` text,
	`app_version` text,
	`client_sdk` text,
	`network_asn` integer,
	`network_name` text,
	`latency_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_auth_event_app_created` ON `app_auth_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `app_auth_event_app_user_created` ON `app_auth_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `app_auth_event_created` ON `app_auth_event` (`created_at`);