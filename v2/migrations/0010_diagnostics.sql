-- Diagnostics reads (step 7b-4): the wait for an entitlement claim, as v1
-- measures it. An end user refused for a missing claim gets
-- `claim_pending_since`; the sign-in that ends the wait records how long it
-- was open on its auth event (`claim_delay_ms`).
ALTER TABLE `app_auth_event` ADD `claim_delay_ms` integer;--> statement-breakpoint
ALTER TABLE `app_end_user` ADD `claim_pending_since` integer;--> statement-breakpoint
CREATE INDEX `app_end_user_claim_pending` ON `app_end_user` (`app_id`) WHERE `claim_pending_since` IS NOT NULL;
