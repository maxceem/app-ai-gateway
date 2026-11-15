ALTER TABLE `app_usage_event` ADD `error` text;--> statement-breakpoint
-- Every failure recorded before this column existed says only that it failed.
-- No trigger watches `error`, so this moves no spend or daily total.
UPDATE `app_usage_event` SET `error` = 'provider_error' WHERE `status` = 'provider_error' AND `error` IS NULL;
