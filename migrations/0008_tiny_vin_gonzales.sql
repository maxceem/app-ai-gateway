ALTER TABLE `apps` RENAME TO `app`;--> statement-breakpoint
ALTER TABLE `api_keys` RENAME TO `app_api_key`;--> statement-breakpoint
ALTER TABLE `auth_challenges` RENAME TO `app_auth_challenge`;--> statement-breakpoint
ALTER TABLE `development_credentials` RENAME TO `app_development_credential`;--> statement-breakpoint
ALTER TABLE `usage_events` RENAME TO `app_usage_event`;--> statement-breakpoint
ALTER TABLE `users` RENAME TO `app_user`;--> statement-breakpoint
ALTER TABLE `operator_api_key` RENAME TO `console_api_key`;--> statement-breakpoint
ALTER TABLE `operator_organization` RENAME TO `console_organization`;--> statement-breakpoint
ALTER TABLE `operator_organization_user` RENAME TO `console_organization_user`;--> statement-breakpoint
ALTER TABLE `operator_user` RENAME TO `console_user`;--> statement-breakpoint
ALTER TABLE `operator_account` RENAME TO `console_user_account`;--> statement-breakpoint
ALTER TABLE `operator_session` RENAME TO `console_user_session`;--> statement-breakpoint
ALTER TABLE `operator_verification` RENAME TO `console_verification`;--> statement-breakpoint

DROP INDEX `operator_api_key_token_hash_unique`;--> statement-breakpoint
DROP INDEX `operator_idx_api_key_organization_id`;--> statement-breakpoint
DROP INDEX `operator_organization_user_organization_id_user_id_unique`;--> statement-breakpoint
DROP INDEX `operator_idx_organization_user_user_id`;--> statement-breakpoint
DROP INDEX `operator_idx_organization_user_organization_id`;--> statement-breakpoint
DROP INDEX `operator_idx_user_email`;--> statement-breakpoint
DROP INDEX `operator_idx_account_user_id`;--> statement-breakpoint
DROP INDEX `operator_idx_account_provider_account`;--> statement-breakpoint
DROP INDEX `operator_idx_session_token`;--> statement-breakpoint
DROP INDEX `operator_idx_session_user_id`;--> statement-breakpoint
DROP INDEX `operator_idx_verification_identifier`;--> statement-breakpoint

CREATE UNIQUE INDEX `console_api_key_token_hash_unique` ON `console_api_key` (`token_hash`);--> statement-breakpoint
CREATE INDEX `console_idx_api_key_organization_id` ON `console_api_key` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_organization_user_organization_id_user_id_unique` ON `console_organization_user` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `console_idx_organization_user_user_id` ON `console_organization_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `console_idx_organization_user_organization_id` ON `console_organization_user` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_idx_user_email` ON `console_user` ("email" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `console_idx_account_user_id` ON `console_user_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_idx_account_provider_account` ON `console_user_account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_idx_session_token` ON `console_user_session` (`token`);--> statement-breakpoint
CREATE INDEX `console_idx_session_user_id` ON `console_user_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `console_idx_verification_identifier` ON `console_verification` (`identifier`);
