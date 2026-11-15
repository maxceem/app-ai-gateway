CREATE TABLE `mgmt_organization_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`response` text,
	`responded_at` text,
	`responded_by_user_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`responded_by_user_id`) REFERENCES `mgmt_user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mgmt_organization_invitation_role_check" CHECK("mgmt_organization_invitation"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "mgmt_organization_invitation_response_check" CHECK("mgmt_organization_invitation"."response" is null or "mgmt_organization_invitation"."response" in ('accepted', 'declined', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_invitation_token_hash_unique` ON `mgmt_organization_invitation` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `mgmt_organization_invitation_open_unique` ON `mgmt_organization_invitation` (`organization_id`,`email`) WHERE "mgmt_organization_invitation"."response" is null;--> statement-breakpoint
CREATE INDEX `mgmt_idx_organization_invitation_email` ON `mgmt_organization_invitation` (`email`);--> statement-breakpoint
ALTER TABLE `mgmt_organization_user` ADD `last_active_at` text;