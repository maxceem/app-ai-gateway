CREATE TABLE `account_activation` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`activated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-written: drizzle-kit generates no data copies.
--
-- Every account that exists when this lands was made without email
-- verification, and some of them already serve traffic. Each is activated, so
-- a deployment that adds an email sender afterwards stops none of them.
INSERT OR IGNORE INTO `account_activation`(`organization_id`, `activated_at`)
SELECT `id`, datetime('now') FROM `mgmt_organization`;
