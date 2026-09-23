-- Two moves of server state into columns and a table of its own.
--
-- `mgmt_handoff` gains the payload digest, the pinned target and gateway
-- revisions and the approval page's snapshots, which were fields mixed into
-- `request_json`. SQLite cannot add a NOT NULL column without a default, so
-- the table is recreated; a handoff lives fifteen minutes, and one open while
-- this runs has to be started again from the CLI.
--
-- CLI bootstraps move out of `mgmt_resource_receipt`, where they were rows of
-- kind 'bootstrap' whose `outcome` held the committed key id or the marker
-- '{"expired":true}', into `mgmt_bootstrap`, with the state those columns
-- implied.
--
-- Hand-written, and deliberately without a transition for the previous
-- Worker, which keeps serving for the few seconds between this migration and
-- its replacement's deploy: its handoff inserts fail, and a bootstrap it
-- records in the old table is not carried over. Nothing depends on either yet.
DROP TABLE `mgmt_handoff`;--> statement-breakpoint
CREATE TABLE `mgmt_handoff` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`request_json` text NOT NULL,
	`request_hash` text NOT NULL,
	`target_id` text,
	`target_revision` integer,
	`gateway_id` text,
	`gateway_revision` integer,
	`snapshot_json` text,
	`organization_id` text NOT NULL,
	`initiating_user_id` text NOT NULL,
	`initiating_credential_id` text NOT NULL,
	`submission_proof_hash` text NOT NULL,
	`poll_proof_hash` text NOT NULL,
	`consumed_at` integer,
	`outcome` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mgmt_handoff_pending` ON `mgmt_handoff` (`organization_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `mgmt_bootstrap` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`organization_id` text,
	`service_user_id` text,
	`proof_hash` text NOT NULL,
	`credential_id` text,
	`protected_credential` text,
	`protected_credential_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_mgmt_bootstrap_organization` ON `mgmt_bootstrap` (`organization_id`);--> statement-breakpoint
INSERT INTO `mgmt_bootstrap`(
	`id`, `state`, `organization_id`, `service_user_id`, `proof_hash`, `credential_id`,
	`protected_credential`, `protected_credential_expires_at`, `created_at`, `updated_at`
)
SELECT
	`id`,
	CASE
		WHEN `outcome` = '{"expired":true}' THEN 'expired'
		WHEN `consumed_at` IS NOT NULL THEN 'retired'
		ELSE 'active'
	END,
	`organization_id`,
	`initiating_user_id`,
	`proof_hash`,
	CASE WHEN json_valid(`outcome`) THEN json_extract(`outcome`, '$.credentialId') END,
	`protected_credential`,
	`protected_credential_expires_at`,
	`created_at`,
	`updated_at`
FROM `mgmt_resource_receipt` WHERE `kind` = 'bootstrap';
--> statement-breakpoint
DELETE FROM `mgmt_resource_receipt` WHERE `kind` = 'bootstrap';
