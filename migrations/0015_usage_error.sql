ALTER TABLE `app_usage_event` ADD `error` text;--> statement-breakpoint
-- Every failure recorded before this column existed says only that it failed.
-- No trigger watches `error`, so this moves no spend or daily total.
UPDATE `app_usage_event` SET `error` = 'provider_error' WHERE `status` = 'provider_error' AND `error` IS NULL;--> statement-breakpoint
-- Code from before this release still writes failures with `status` alone: in
-- the moments between this migration and the new code going live, and after a
-- rollback. Every reader now counts a failure by its `error`, so such a row is
-- given the same `error` the backfill gave the rest. Temporary: it goes with
-- the `status` column.
CREATE TRIGGER app_usage_event_error_from_status
AFTER INSERT ON app_usage_event
WHEN NEW.status = 'provider_error' AND NEW.error IS NULL
BEGIN
	UPDATE app_usage_event SET error = 'provider_error' WHERE id = NEW.id;
END;
