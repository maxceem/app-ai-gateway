-- Step 8j (split keys, phase 1): an account's root public key, and keyslots
-- that hold the root key sealed to each credential. No row in
-- account_key_root means split keys are off, as for every account today.
CREATE TABLE `account_key_root` (
	`account_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`mode` text NOT NULL,
	`migration_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_key_root_mode" CHECK("account_key_root"."mode" IN ('off', 'migrating', 'on'))
);
--> statement-breakpoint
CREATE TABLE `key_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`credential_kind` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`sealed_root` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `key_slot_credential` ON `key_slot` (`credential_kind`,`credential_id`);--> statement-breakpoint
CREATE INDEX `key_slot_account` ON `key_slot` (`account_id`);