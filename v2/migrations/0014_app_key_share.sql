-- Step 8j (split keys, phase 3): iOS shares. An App Attest app sends its share
-- at /auth/token; only the share's keyslot (key_slot, kind ios_share) and
-- this row are stored, never the share. Nothing reads this table until an
-- account has split keys on.
CREATE TABLE `app_key_share` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_key_share_status" CHECK("app_key_share"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `app_key_share_app` ON `app_key_share` (`app_id`);