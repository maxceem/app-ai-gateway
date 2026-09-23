-- One table for every CLI operation: a bootstrap, an account claim, and each
-- resource write the CLI sends — immediately, or after a browser step. Its id
-- is the digest of the one token the CLI holds, which is the whole proof.
CREATE TABLE `mgmt_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`organization_id` text,
	`initiating_user_id` text,
	`initiating_credential_id` text,
	`request_json` text,
	`request_hash` text NOT NULL,
	`browser_proof_hash` text,
	`outcome_json` text,
	`sealed_outcome` text,
	`sealed_until` integer,
	`credential_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_mgmt_operation_organization` ON `mgmt_operation` (`organization_id`,`state`,`expires_at`);
