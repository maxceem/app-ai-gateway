CREATE TABLE `app_rejection_event` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text,
	`install_id` text,
	`app_key_id` text,
	`reason` text NOT NULL,
	`scope` text,
	`provider_slug` text,
	`model` text,
	`operation` text,
	`app_version` text,
	`auth_method` text,
	`latency_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_created` ON `app_rejection_event` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `app_rejection_event_app_user_created` ON `app_rejection_event` (`app_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `app_rejection_event_created` ON `app_rejection_event` (`created_at`);--> statement-breakpoint
-- The rollup trigger (plan section 4.2). Hand-written: drizzle does not
-- generate triggers. It runs only for a row really inserted, so a write
-- retried with ON CONFLICT(id) DO NOTHING never counts twice. A correction
-- adds its difference to the same day and key; it never counts as a charge.
-- Missing key parts are '' and an empty cost counts as 0.
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
	ON CONFLICT (app_id, day, provider_type, provider_connection_id, model, outcome, unit) DO UPDATE SET
		charges = charges + excluded.charges,
		unpriced_charges = unpriced_charges + excluded.unpriced_charges,
		cost_nano = cost_nano + excluded.cost_nano,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		units = units + excluded.units,
		session_ms = session_ms + excluded.session_ms;
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
