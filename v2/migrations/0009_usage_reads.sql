-- Usage reads (step 7b-3). Hand-written around what drizzle generates:
--
-- - The day rollup's key names the account. An app id can come back in
--   another account after deletion; without the account in the key, the two
--   apps' charges on one day would add up in one row under the first account.
-- - The rollup trigger names that key in its ON CONFLICT, so it is dropped
--   first (renaming a table re-checks every trigger) and made again at the
--   end. It is the trigger of 0002_ledger.sql with two changes: the new key,
--   and the first correction of an unpriced charge taking it back out of
--   `unpriced_charges`, in the charge's own row, so the count means "still has
--   no price". A correction is only written with a price (a pricing correction
--   or a settlement in dollars or priced units), so the first one prices it.
-- - Rows copy over, then the same rule is applied once to charges already
--   corrected before this migration.
DROP TRIGGER charge_rollup_after_insert;--> statement-breakpoint
DROP INDEX `charge_app_used`;--> statement-breakpoint
CREATE INDEX `charge_app_account_used` ON `charge` (`app_id`,`account_id`,`used_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_usage_day` (
	`account_id` text NOT NULL,
	`app_id` text NOT NULL,
	`day` text NOT NULL,
	`provider_type` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`model` text NOT NULL,
	`outcome` text NOT NULL,
	`unit` text NOT NULL,
	`charges` integer DEFAULT 0 NOT NULL,
	`unpriced_charges` integer DEFAULT 0 NOT NULL,
	`cost_nano` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`session_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `app_id`, `day`, `provider_type`, `provider_connection_id`, `model`, `outcome`, `unit`),
	CONSTRAINT "usage_day_outcome" CHECK("outcome" IN ('ok', 'failed')),
	CONSTRAINT "usage_day_cost_integer" CHECK(typeof("cost_nano") = 'integer')
);
--> statement-breakpoint
INSERT INTO `__new_usage_day`("account_id", "app_id", "day", "provider_type", "provider_connection_id", "model", "outcome", "unit", "charges", "unpriced_charges", "cost_nano", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "units", "session_ms") SELECT "account_id", "app_id", "day", "provider_type", "provider_connection_id", "model", "outcome", "unit", "charges", "unpriced_charges", "cost_nano", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "units", "session_ms" FROM `usage_day`;--> statement-breakpoint
-- Charges corrected before this migration still count as unpriced: each one's
-- first correction prices it, by the trigger's rule below.
-- Driven from the corrected charges, so it reads only corrections and looks
-- each charge and row up by its key: never an app's whole history per row.
UPDATE `__new_usage_day` SET `unpriced_charges` = `unpriced_charges` - priced.n
FROM (
	SELECT o.account_id, o.app_id, o.usage_day AS day, o.provider_type,
		COALESCE(o.provider_connection_id, '') AS provider_connection_id,
		COALESCE(o.model, '') AS model,
		CASE WHEN o.status = 'ok' THEN 'ok' ELSE 'failed' END AS outcome,
		COALESCE(o.unit, '') AS unit,
		COUNT(*) AS n
	FROM charge AS o
	WHERE o.id IN (SELECT c.corrects_charge_id FROM charge AS c WHERE c.corrects_charge_id IS NOT NULL)
		AND o.kind != 'correction' AND o.price_source IN ('unresolved', 'not_priced')
	GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
) AS priced
WHERE `__new_usage_day`.account_id = priced.account_id AND `__new_usage_day`.app_id = priced.app_id
	AND `__new_usage_day`.day = priced.day AND `__new_usage_day`.provider_type = priced.provider_type
	AND `__new_usage_day`.provider_connection_id = priced.provider_connection_id
	AND `__new_usage_day`.model = priced.model AND `__new_usage_day`.outcome = priced.outcome
	AND `__new_usage_day`.unit = priced.unit;--> statement-breakpoint
DROP TABLE `usage_day`;--> statement-breakpoint
ALTER TABLE `__new_usage_day` RENAME TO `usage_day`;--> statement-breakpoint
CREATE INDEX `usage_day_account` ON `usage_day` (`account_id`,`day`);--> statement-breakpoint
CREATE INDEX `usage_day_day` ON `usage_day` (`day`);--> statement-breakpoint
CREATE TRIGGER charge_rollup_after_insert
AFTER INSERT ON charge
BEGIN
	INSERT INTO usage_day (
		account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit,
		charges, unpriced_charges, cost_nano, input_tokens, cached_input_tokens, cache_write_tokens,
		output_tokens, units, session_ms
	) VALUES (
		NEW.account_id, NEW.app_id, NEW.usage_day, NEW.provider_type,
		COALESCE(NEW.provider_connection_id, ''), COALESCE(NEW.model, ''),
		CASE WHEN NEW.status = 'ok' THEN 'ok' ELSE 'failed' END, COALESCE(NEW.unit, ''),
		NEW.kind != 'correction',
		NEW.kind != 'correction' AND NEW.price_source IN ('unresolved', 'not_priced'),
		COALESCE(NEW.cost_nano, 0), COALESCE(NEW.input_tokens, 0), COALESCE(NEW.cached_input_tokens, 0),
		COALESCE(NEW.cache_write_tokens, 0), COALESCE(NEW.output_tokens, 0), COALESCE(NEW.units, 0),
		COALESCE(NEW.session_ms, 0)
	)
	ON CONFLICT (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit) DO UPDATE SET
		charges = charges + excluded.charges,
		unpriced_charges = unpriced_charges + excluded.unpriced_charges,
		cost_nano = cost_nano + excluded.cost_nano,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		units = units + excluded.units,
		session_ms = session_ms + excluded.session_ms;
	-- The first correction of a charge that had no price prices it (pricing,
	-- or a settlement in dollars or priced units): that charge leaves
	-- `unpriced_charges`, in the row it was counted in (a correction is dated
	-- on its charge's day, but its cost may land under the price's unit). A
	-- later correction of the same charge changes nothing here.
	INSERT INTO usage_day (
		account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, unpriced_charges
	)
	SELECT o.account_id, o.app_id, o.usage_day, o.provider_type,
		COALESCE(o.provider_connection_id, ''), COALESCE(o.model, ''),
		CASE WHEN o.status = 'ok' THEN 'ok' ELSE 'failed' END, COALESCE(o.unit, ''), -1
	FROM charge AS o
	WHERE NEW.kind = 'correction' AND o.id = NEW.corrects_charge_id
		AND o.kind != 'correction' AND o.price_source IN ('unresolved', 'not_priced')
		AND NOT EXISTS (SELECT 1 FROM charge AS earlier
		                WHERE earlier.corrects_charge_id = o.id AND earlier.id != NEW.id)
	ON CONFLICT (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit) DO UPDATE SET
		unpriced_charges = unpriced_charges + excluded.unpriced_charges;
	-- Budget totals: the app always, and each end-user scope the charge names.
	-- Only charges that move money or session time.
	INSERT INTO budget_day (app_id, scope, scope_id, day, cost_nano, session_ms)
	SELECT NEW.app_id, scopes.scope, scopes.scope_id, NEW.usage_day, COALESCE(NEW.cost_nano, 0), COALESCE(NEW.session_ms, 0)
	FROM (
		SELECT 'app' AS scope, NEW.app_id AS scope_id
		UNION ALL SELECT 'user', NEW.end_user_id WHERE NEW.end_user_id IS NOT NULL
		UNION ALL SELECT 'install', NEW.install_id WHERE NEW.install_id IS NOT NULL
		UNION ALL SELECT 'apple_account', NEW.apple_account_id WHERE NEW.apple_account_id IS NOT NULL
	) AS scopes
	WHERE COALESCE(NEW.cost_nano, 0) != 0 OR COALESCE(NEW.session_ms, 0) != 0
	ON CONFLICT (app_id, scope, scope_id, day) DO UPDATE SET
		cost_nano = cost_nano + excluded.cost_nano,
		session_ms = session_ms + excluded.session_ms;
END;
