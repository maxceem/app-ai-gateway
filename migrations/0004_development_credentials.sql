CREATE TABLE `development_credentials` (
	`app_id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`rotated_at` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
