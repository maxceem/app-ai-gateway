-- Recording identity for usage events, so a retried insert is a no-op instead
-- of a duplicate row. Existing rows keep a NULL `event_id`: SQLite counts every
-- NULL as distinct in a unique index, so they do not collide with each other.
ALTER TABLE `app_usage_event` ADD `event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_event_id_unique` ON `app_usage_event` (`event_id`);