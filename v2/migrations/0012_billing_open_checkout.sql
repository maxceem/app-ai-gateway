CREATE TABLE `billing_open_checkout` (
	`account_id` text PRIMARY KEY NOT NULL,
	`plan_key` text NOT NULL,
	`billing_period` text NOT NULL,
	`url` text,
	`claim_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
