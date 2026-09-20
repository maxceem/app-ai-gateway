ALTER TABLE `provider` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_gateway` ADD `revision` integer DEFAULT 1 NOT NULL;