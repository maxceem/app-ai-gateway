-- Moves CLI bootstraps out of `mgmt_resource_receipt`, where they were rows of
-- kind 'bootstrap' whose `outcome` held either the committed key id or the
-- marker '{"expired":true}', into a table with a state of its own.
--
-- Existing rows are copied with the state their columns implied. The receipt
-- rows are left where they are, because migrations run before the new Worker
-- is deployed and the previous one still serving until then checks its proofs
-- and expiry tombstones there. Nothing from this version reads them, and a
-- later migration removes them once no older Worker can be serving.
--
-- A bootstrap the previous Worker starts inside that window lands only in the
-- old table: on a hosted deployment the CLI's next poll creates a fresh
-- unclaimed account and the stranded one expires like any other, and a
-- self-host refuses it as already initialized.
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
