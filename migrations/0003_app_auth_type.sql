ALTER TABLE `app` ADD `auth_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill: the column is the configuration's own authentication.type, and
-- every existing row already carries one inside config_json. The ADD above
-- defaults to '' only so it can run on a populated table; no row keeps that.
UPDATE app SET auth_type = json_extract(config_json, '$.authentication.type');
