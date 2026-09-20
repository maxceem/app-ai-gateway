CREATE TABLE `app_usage_spend` (
	`id` integer PRIMARY KEY NOT NULL,
	`organization_id` text,
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`user_key` text NOT NULL,
	`month` text NOT NULL,
	`microusd` integer NOT NULL,
	`revision` integer NOT NULL,
	`pending` integer DEFAULT 1 NOT NULL,
	`last_attempt_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "app_usage_spend_scope_check" CHECK("app_usage_spend"."scope" IN ('app', 'user')),
	CONSTRAINT "app_usage_spend_month_check" CHECK("app_usage_spend"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("app_usage_spend"."month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "app_usage_spend_microusd_check" CHECK("app_usage_spend"."microusd" >= 0),
	CONSTRAINT "app_usage_spend_revision_check" CHECK("app_usage_spend"."revision" > 0),
	CONSTRAINT "app_usage_spend_pending_check" CHECK("app_usage_spend"."pending" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_usage_spend_scope_month_unique` ON `app_usage_spend` (`scope`,`app_id`,`user_key`,`month`);--> statement-breakpoint
CREATE INDEX `idx_app_usage_spend_pending` ON `app_usage_spend` (`pending`,`last_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_app_usage_spend_app_month` ON `app_usage_spend` (`app_id`,`month`,`pending`,`last_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_app_usage_spend_organization` ON `app_usage_spend` (`organization_id`);--> statement-breakpoint
-- One canonical total per app scope and, where an event names a user, per user
-- scope. Historical rows that predate durable ownership keep a NULL owner.
INSERT INTO app_usage_spend(
	organization_id, app_id, scope, user_key, month,
	microusd, revision, pending, last_attempt_at
)
SELECT
	COALESCE(MAX(NULLIF(events.organization_id, '')), MAX(app.organization_id)),
	events.app_id,
	'app',
	'',
	substr(events.created_at, 1, 7),
	SUM(CAST(ROUND(events.cost_usd * 1000000) AS INTEGER)),
	1,
	1,
	0
FROM app_usage_event AS events
LEFT JOIN app ON app.id = events.app_id
WHERE CAST(ROUND(events.cost_usd * 1000000) AS INTEGER) != 0
GROUP BY events.app_id, substr(events.created_at, 1, 7)
HAVING SUM(CAST(ROUND(events.cost_usd * 1000000) AS INTEGER)) != 0
UNION ALL
SELECT
	COALESCE(MAX(NULLIF(events.organization_id, '')), MAX(app.organization_id)),
	events.app_id,
	'user',
	events.user_id,
	substr(events.created_at, 1, 7),
	SUM(CAST(ROUND(events.cost_usd * 1000000) AS INTEGER)),
	1,
	1,
	0
FROM app_usage_event AS events
LEFT JOIN app ON app.id = events.app_id
WHERE events.user_id IS NOT NULL
	AND CAST(ROUND(events.cost_usd * 1000000) AS INTEGER) != 0
GROUP BY events.app_id, events.user_id, substr(events.created_at, 1, 7)
HAVING SUM(CAST(ROUND(events.cost_usd * 1000000) AS INTEGER)) != 0;--> statement-breakpoint
-- A provider response may finish after account cleanup. Refuse that late fact
-- in the same D1 statement so it cannot recreate aggregate ownership after the
-- account row is gone. Empty ownership remains valid for historical imports.
CREATE TRIGGER app_usage_event_owner_guard_before_insert
BEFORE INSERT ON app_usage_event
WHEN NEW.organization_id != ''
	AND NOT EXISTS (
		SELECT 1 FROM mgmt_organization WHERE id = NEW.organization_id
	)
BEGIN
	SELECT RAISE(ABORT, 'app_usage_event organization no longer exists');
END;--> statement-breakpoint
-- Event insertion and both totals commit under D1's one write transaction.
-- INSERT OR IGNORE retries do not fire this trigger, so duplicate event ids are
-- inherently harmless without a second per-event deduplication ledger.
CREATE TRIGGER app_usage_event_spend_after_insert
AFTER INSERT ON app_usage_event
WHEN CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0
BEGIN
	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month,
		microusd, revision, pending, last_attempt_at
	) VALUES (
		NULLIF(NEW.organization_id, ''), NEW.app_id, 'app', '',
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER), 1, 1, 0
	)
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		organization_id = COALESCE(app_usage_spend.organization_id, excluded.organization_id),
		microusd = app_usage_spend.microusd + excluded.microusd,
		revision = app_usage_spend.revision + 1,
		pending = 1;

	INSERT INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month,
		microusd, revision, pending, last_attempt_at
	)
	SELECT
		NULLIF(NEW.organization_id, ''), NEW.app_id, 'user', NEW.user_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER), 1, 1, 0
	WHERE NEW.user_id IS NOT NULL
	ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET
		organization_id = COALESCE(app_usage_spend.organization_id, excluded.organization_id),
		microusd = app_usage_spend.microusd + excluded.microusd,
		revision = app_usage_spend.revision + 1,
		pending = 1;
END;--> statement-breakpoint
-- Repricing changes only cost_usd. Applying the rounded per-event delta keeps
-- the aggregate equal to SUM(ROUND(event cost)) across increases and reductions
-- to zero; raw event deletion intentionally has no inverse trigger.
CREATE TRIGGER app_usage_event_spend_after_cost_update
AFTER UPDATE OF cost_usd ON app_usage_event
WHEN CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
	!= CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER)
BEGIN
	UPDATE app_usage_spend SET
		organization_id = COALESCE(organization_id, NULLIF(NEW.organization_id, '')),
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER),
		revision = revision + 1,
		pending = 1
	WHERE scope = 'app'
		AND app_id = NEW.app_id
		AND user_key = ''
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month,
		microusd, revision, pending, last_attempt_at
	)
	SELECT
		NULLIF(NEW.organization_id, ''), NEW.app_id, 'app', '',
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER),
		1, 1, 0
	WHERE CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;

	UPDATE app_usage_spend SET
		organization_id = COALESCE(organization_id, NULLIF(NEW.organization_id, '')),
		microusd = microusd
			+ CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER)
			- CAST(ROUND(OLD.cost_usd * 1000000) AS INTEGER),
		revision = revision + 1,
		pending = 1
	WHERE NEW.user_id IS NOT NULL
		AND scope = 'user'
		AND app_id = NEW.app_id
		AND user_key = NEW.user_id
		AND month = substr(NEW.created_at, 1, 7);

	INSERT OR IGNORE INTO app_usage_spend(
		organization_id, app_id, scope, user_key, month,
		microusd, revision, pending, last_attempt_at
	)
	SELECT
		NULLIF(NEW.organization_id, ''), NEW.app_id, 'user', NEW.user_id,
		substr(NEW.created_at, 1, 7),
		CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER),
		1, 1, 0
	WHERE NEW.user_id IS NOT NULL
		AND CAST(ROUND(NEW.cost_usd * 1000000) AS INTEGER) != 0;
END;
