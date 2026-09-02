CREATE TABLE `operator_account` (
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
	FOREIGN KEY (`user_id`) REFERENCES `operator_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operator_idx_account_user_id` ON `operator_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `operator_idx_account_provider_account` ON `operator_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `operator_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `operator_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_api_key_token_hash_unique` ON `operator_api_key` (`token_hash`);--> statement-breakpoint
CREATE INDEX `operator_idx_api_key_organization_id` ON `operator_api_key` (`organization_id`);--> statement-breakpoint
CREATE TABLE `operator_organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `operator_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `operator_organization_user` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `operator_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `operator_user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "operator_organization_user_role_check" CHECK("operator_organization_user"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "operator_organization_user_status_check" CHECK("operator_organization_user"."status" in ('active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_organization_user_organization_id_user_id_unique` ON `operator_organization_user` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `operator_idx_organization_user_user_id` ON `operator_organization_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `operator_idx_organization_user_organization_id` ON `operator_organization_user` (`organization_id`);--> statement-breakpoint
CREATE TABLE `operator_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `operator_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_idx_session_token` ON `operator_session` (`token`);--> statement-breakpoint
CREATE INDEX `operator_idx_session_user_id` ON `operator_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `operator_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_idx_user_email` ON `operator_user` ("email" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `operator_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `operator_idx_verification_identifier` ON `operator_verification` (`identifier`);--> statement-breakpoint
ALTER TABLE `apps` ADD `organization_id` text REFERENCES operator_organization(id);--> statement-breakpoint
CREATE INDEX `idx_apps_organization_id` ON `apps` (`organization_id`);