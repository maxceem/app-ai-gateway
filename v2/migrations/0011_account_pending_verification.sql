CREATE TABLE `account_pending_verification` (
	`account_id` text PRIMARY KEY NOT NULL,
	`marked_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `account_activation`;