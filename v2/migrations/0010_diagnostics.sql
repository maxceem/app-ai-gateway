-- Diagnostics reads (step 7b-4).
-- An app id is never given out twice: every deleted app's id goes into
-- `retired_app_id`, and a new app's id is checked against it and `app`. So
-- rows that name an app by id alone never mix two apps' history.
-- Both event tables also record the account that owned the app when the
-- event happened (`account_id`), and every read filters by it. The indexes
-- end in the lists' full order (time, then id), so a page needs no sort. The
-- wait for an entitlement claim is measured as v1 does: an end user refused
-- for a missing claim gets `claim_pending_since`, and the sign-in that ends
-- the wait records how long it was open (`claim_delay_ms`); the claim-wait
-- index covers the percentile reads.
CREATE TABLE `retired_app_id` (
	`id` text PRIMARY KEY NOT NULL,
	`retired_at` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `app_auth_event_app_created`;--> statement-breakpoint
DROP INDEX `app_auth_event_app_user_created`;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `claim_delay_ms` integer;--> statement-breakpoint
CREATE INDEX `app_auth_event_app_account_created` ON `app_auth_event` (`app_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `app_auth_event_claim_delay` ON `app_auth_event` (`app_id`,`account_id`,`claim_delay_ms`,`created_at`) WHERE claim_delay_ms IS NOT NULL;--> statement-breakpoint
CREATE INDEX `app_auth_event_app_user_created` ON `app_auth_event` (`app_id`,`user_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
DROP INDEX `app_rejection_event_app_created`;--> statement-breakpoint
DROP INDEX `app_rejection_event_app_user_created`;--> statement-breakpoint
ALTER TABLE `app_rejection_event` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_account_created` ON `app_rejection_event` (`app_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `app_end_user` ADD `claim_pending_since` integer;--> statement-breakpoint
CREATE INDEX `app_end_user_claim_pending` ON `app_end_user` (`app_id`,`status`,`claim_pending_since`) WHERE claim_pending_since IS NOT NULL;