ALTER TABLE `app_auth_challenge` ADD `app_version` text;--> statement-breakpoint
ALTER TABLE `app_auth_challenge` ADD `client_sdk` text;--> statement-breakpoint
ALTER TABLE `app_auth_challenge` ADD `network_asn` integer;--> statement-breakpoint
ALTER TABLE `app_auth_challenge` ADD `network_name` text;--> statement-breakpoint
ALTER TABLE `app_auth_challenge` ADD `attempted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `network_asn` integer;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `network_name` text;