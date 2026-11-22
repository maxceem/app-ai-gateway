-- Diagnostics reads (step 7b-4).
-- Both event tables record the account that owned the app when the event
-- happened (`account_id`), and every read filters by it, so an app id that
-- comes back in another account never shows the old account's events. The
-- indexes end in the lists' full order (time, then id), so a page needs no
-- sort. The wait for an entitlement claim is measured as v1 does: an end user
-- refused for a missing claim gets `claim_pending_since`, and the sign-in that
-- ends the wait records how long it was open (`claim_delay_ms`).
DROP INDEX `app_auth_event_app_created`;--> statement-breakpoint
DROP INDEX `app_auth_event_app_user_created`;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `app_auth_event` ADD `claim_delay_ms` integer;--> statement-breakpoint
CREATE INDEX `app_auth_event_app_account_created` ON `app_auth_event` (`app_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `app_auth_event_claim_delay` ON `app_auth_event` (`app_id`,`account_id`,`claim_delay_ms`) WHERE claim_delay_ms IS NOT NULL;--> statement-breakpoint
CREATE INDEX `app_auth_event_app_user_created` ON `app_auth_event` (`app_id`,`user_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
DROP INDEX `app_rejection_event_app_created`;--> statement-breakpoint
DROP INDEX `app_rejection_event_app_user_created`;--> statement-breakpoint
ALTER TABLE `app_rejection_event` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_account_created` ON `app_rejection_event` (`app_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`account_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `app_end_user` ADD `claim_pending_since` integer;--> statement-breakpoint
CREATE INDEX `app_end_user_claim_pending` ON `app_end_user` (`app_id`) WHERE claim_pending_since IS NOT NULL;