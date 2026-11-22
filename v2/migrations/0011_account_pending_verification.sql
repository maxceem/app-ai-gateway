CREATE TABLE `email_pending_verification` (
	`email` text PRIMARY KEY NOT NULL,
	`marked_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `account_activation`;