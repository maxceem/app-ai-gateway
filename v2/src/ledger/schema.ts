/**
 * The ledger object's schema (plan section 8, step 8f; D21): the eight tables
 * that record what happened in one account, with their indexes and the rollup
 * trigger. Each object brings its own database up to `LEDGER_SCHEMA.length`
 * when it wakes (`../do/AccountLedger.ts`): version N is `LEDGER_SCHEMA[N - 1]`.
 *
 * Never edit a version once it is merged. A change is a new version at the
 * end, as D1 migrations are. Version 1 is what D1 held before step 8f moved
 * these tables out of it (migrations 0000 to 0011).
 */
export const LEDGER_SCHEMA: readonly (readonly string[])[] = [
  [
    `CREATE TABLE \`app_auth_event\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`app_id\` text NOT NULL,
  \`user_id\` text,
  \`event\` text NOT NULL,
  \`auth_method\` text,
  \`outcome\` text NOT NULL,
  \`reason\` text,
  \`app_version\` text,
  \`client_sdk\` text,
  \`network_asn\` integer,
  \`network_name\` text,
  \`latency_ms\` integer,
  \`created_at\` integer NOT NULL
, \`account_id\` text, \`claim_delay_ms\` integer)`,
    `CREATE TABLE \`app_rejection_event\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`app_id\` text NOT NULL,
  \`user_id\` text,
  \`install_id\` text,
  \`app_key_id\` text,
  \`reason\` text NOT NULL,
  \`scope\` text,
  \`provider_slug\` text,
  \`model\` text,
  \`operation\` text,
  \`app_version\` text,
  \`auth_method\` text,
  \`latency_ms\` integer,
  \`created_at\` integer NOT NULL
, \`account_id\` text)`,
    `CREATE TABLE \`budget_day\` (
  \`app_id\` text NOT NULL,
  \`scope\` text NOT NULL,
  \`scope_id\` text NOT NULL,
  \`day\` text NOT NULL,
  \`cost_nano\` integer DEFAULT 0 NOT NULL,
  \`session_ms\` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(\`app_id\`, \`scope\`, \`scope_id\`, \`day\`),
  CONSTRAINT "budget_day_scope" CHECK("budget_day"."scope" IN ('app', 'user', 'install', 'apple_account')),
  CONSTRAINT "budget_day_cost_integer" CHECK(typeof("budget_day"."cost_nano") = 'integer')
)`,
    `CREATE TABLE \`charge\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`kind\` text NOT NULL,
  \`account_id\` text NOT NULL,
  \`app_id\` text NOT NULL,
  \`end_user_id\` text,
  \`install_id\` text,
  \`apple_account_id\` text,
  \`app_key_id\` text,
  \`owner_type\` text NOT NULL,
  \`owner_id\` text NOT NULL,
  \`seq\` integer,
  \`provider_type\` text NOT NULL,
  \`provider_connection_id\` text,
  \`operation\` text NOT NULL,
  \`preset\` text,
  \`model\` text,
  \`status\` text NOT NULL,
  \`http_status\` integer,
  \`error_code\` text,
  \`cost_nano\` integer,
  \`measured\` text NOT NULL,
  \`price_source\` text NOT NULL,
  \`price_is_estimate\` integer DEFAULT false NOT NULL,
  \`input_tokens\` integer,
  \`cached_input_tokens\` integer,
  \`cache_write_tokens\` integer,
  \`output_tokens\` integer,
  \`unit\` text,
  \`units\` integer,
  \`measures_json\` text NOT NULL,
  \`rates_json\` text,
  \`session_ms\` integer,
  \`correction_kind\` text,
  \`corrects_charge_id\` text,
  \`latency_ms\` integer,
  \`app_version\` text,
  \`auth_method\` text,
  \`client_trace_id\` text,
  \`used_at\` integer NOT NULL,
  \`usage_day\` text NOT NULL,
  \`written_at\` integer NOT NULL,
  CONSTRAINT "charge_kind" CHECK("charge"."kind" IN ('attempt', 'slice', 'estimate', 'correction')),
  CONSTRAINT "charge_owner_type" CHECK("charge"."owner_type" IN ('call', 'session', 'job')),
  CONSTRAINT "charge_measured" CHECK("charge"."measured" IN ('complete', 'partial', 'estimated', 'pending')),
  CONSTRAINT "charge_price_source" CHECK("charge"."price_source" IN ('provider_usd', 'list_rate', 'customer_rate', 'unresolved', 'not_priced')),
  CONSTRAINT "charge_correction" CHECK(("charge"."kind" = 'correction') = ("charge"."correction_kind" IS NOT NULL)
        AND ("charge"."correction_kind" IS NULL OR "charge"."correction_kind" IN ('units', 'dollars', 'pricing'))),
  CONSTRAINT "charge_corrects_only_corrections" CHECK("charge"."corrects_charge_id" IS NULL OR "charge"."kind" = 'correction'),
  CONSTRAINT "charge_session_ms" CHECK("charge"."session_ms" IS NULL OR "charge"."kind" = 'slice'),
  CONSTRAINT "charge_usage_day" CHECK(length("charge"."usage_day") = 10),
  CONSTRAINT "charge_cost_integer" CHECK("charge"."cost_nano" IS NULL OR typeof("charge"."cost_nano") = 'integer')
)`,
    `CREATE TABLE \`open_work\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`kind\` text NOT NULL,
  \`account_id\` text NOT NULL,
  \`app_id\` text NOT NULL,
  \`owner_type\` text NOT NULL,
  \`owner_id\` text NOT NULL,
  \`charge_id\` text,
  \`detail_json\` text,
  \`due_at\` integer NOT NULL,
  \`tries\` integer DEFAULT 0 NOT NULL,
  \`last_error\` text,
  \`created_at\` integer NOT NULL, \`gave_up_at\` integer,
  CONSTRAINT "open_work_kind" CHECK("open_work"."kind" IN ('provider_lookup', 'unresolved', 'stale_session', 'job_check')),
  CONSTRAINT "open_work_owner_type" CHECK("open_work"."owner_type" IN ('call', 'session', 'job'))
)`,
    `CREATE TABLE \`session\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`account_id\` text NOT NULL,
  \`app_id\` text NOT NULL,
  \`end_user_id\` text,
  \`install_id\` text,
  \`apple_account_id\` text,
  \`app_key_id\` text,
  \`provider_type\` text NOT NULL,
  \`provider_connection_id\` text,
  \`operation\` text NOT NULL,
  \`model\` text,
  \`mode\` text NOT NULL,
  \`slot\` text NOT NULL,
  \`state\` text NOT NULL,
  \`end_reason\` text,
  \`provider_call_id\` text,
  \`replaced_by\` text,
  \`time_cap_ms\` integer NOT NULL,
  \`started_at\` integer NOT NULL,
  \`ended_at\` integer,
  \`gaps\` integer DEFAULT 0 NOT NULL,
  \`final_slice\` integer,
  \`expects_session_total\` integer DEFAULT false NOT NULL,
  \`settlement\` text DEFAULT 'open' NOT NULL,
  \`session_total_nano\` integer,
  \`settled_at\` integer,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL,
  CONSTRAINT "session_mode" CHECK("session"."mode" IN ('relayed', 'observed')),
  CONSTRAINT "session_slot" CHECK("session"."slot" IN ('conversational', 'streaming')),
  CONSTRAINT "session_state" CHECK("session"."state" IN ('starting', 'active', 'ended')),
  CONSTRAINT "session_settlement" CHECK("session"."settlement" IN ('open', 'settled', 'estimate_kept')),
  CONSTRAINT "session_total_integer" CHECK("session"."session_total_nano" IS NULL OR typeof("session"."session_total_nano") = 'integer')
)`,
    `CREATE TABLE \`usage_day\` (
  \`account_id\` text NOT NULL,
  \`app_id\` text NOT NULL,
  \`day\` text NOT NULL,
  \`provider_type\` text NOT NULL,
  \`provider_connection_id\` text NOT NULL,
  \`model\` text NOT NULL,
  \`outcome\` text NOT NULL,
  \`unit\` text NOT NULL,
  \`charges\` integer DEFAULT 0 NOT NULL,
  \`unpriced_charges\` integer DEFAULT 0 NOT NULL,
  \`cost_nano\` integer DEFAULT 0 NOT NULL,
  \`input_tokens\` integer DEFAULT 0 NOT NULL,
  \`cached_input_tokens\` integer DEFAULT 0 NOT NULL,
  \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
  \`output_tokens\` integer DEFAULT 0 NOT NULL,
  \`units\` integer DEFAULT 0 NOT NULL,
  \`session_ms\` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(\`account_id\`, \`app_id\`, \`day\`, \`provider_type\`, \`provider_connection_id\`, \`model\`, \`outcome\`, \`unit\`),
  CONSTRAINT "usage_day_outcome" CHECK("outcome" IN ('ok', 'failed')),
  CONSTRAINT "usage_day_cost_integer" CHECK(typeof("cost_nano") = 'integer')
)`,
    `CREATE TABLE \`usage_month\` (
  \`account_id\` text NOT NULL,
  \`app_id\` text NOT NULL,
  \`month\` text NOT NULL,
  \`provider_type\` text NOT NULL,
  \`provider_connection_id\` text NOT NULL,
  \`model\` text NOT NULL,
  \`outcome\` text NOT NULL,
  \`unit\` text NOT NULL,
  \`charges\` integer DEFAULT 0 NOT NULL,
  \`unpriced_charges\` integer DEFAULT 0 NOT NULL,
  \`cost_nano\` integer DEFAULT 0 NOT NULL,
  \`input_tokens\` integer DEFAULT 0 NOT NULL,
  \`cached_input_tokens\` integer DEFAULT 0 NOT NULL,
  \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
  \`output_tokens\` integer DEFAULT 0 NOT NULL,
  \`units\` integer DEFAULT 0 NOT NULL,
  \`session_ms\` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(\`account_id\`, \`app_id\`, \`month\`, \`provider_type\`, \`provider_connection_id\`, \`model\`, \`outcome\`, \`unit\`),
  CONSTRAINT "usage_month_outcome" CHECK("usage_month"."outcome" IN ('ok', 'failed')),
  CONSTRAINT "usage_month_month" CHECK(length("usage_month"."month") = 7),
  CONSTRAINT "usage_month_cost_integer" CHECK(typeof("usage_month"."cost_nano") = 'integer')
)`,
    `CREATE INDEX \`app_auth_event_app_account_created\` ON \`app_auth_event\` (\`app_id\`,\`account_id\`,\`created_at\`,\`id\`)`,
    `CREATE INDEX \`app_auth_event_app_user_created\` ON \`app_auth_event\` (\`app_id\`,\`user_id\`,\`account_id\`,\`created_at\`,\`id\`)`,
    `CREATE INDEX \`app_auth_event_claim_delay\` ON \`app_auth_event\` (\`app_id\`,\`account_id\`,\`claim_delay_ms\`,\`created_at\`) WHERE claim_delay_ms IS NOT NULL`,
    `CREATE INDEX \`app_auth_event_created\` ON \`app_auth_event\` (\`created_at\`)`,
    `CREATE INDEX \`app_rejection_event_app_account_created\` ON \`app_rejection_event\` (\`app_id\`,\`account_id\`,\`created_at\`,\`id\`)`,
    `CREATE INDEX \`app_rejection_event_app_user_created\` ON \`app_rejection_event\` (\`app_id\`,\`user_id\`,\`account_id\`,\`created_at\`,\`id\`)`,
    `CREATE INDEX \`app_rejection_event_created\` ON \`app_rejection_event\` (\`created_at\`)`,
    `CREATE INDEX \`budget_day_day\` ON \`budget_day\` (\`day\`)`,
    `CREATE INDEX \`charge_account_used\` ON \`charge\` (\`account_id\`,\`used_at\`)`,
    `CREATE INDEX \`charge_app_account_used\` ON \`charge\` (\`app_id\`,\`account_id\`,\`used_at\`,\`id\`)`,
    `CREATE INDEX \`charge_app_user_used\` ON \`charge\` (\`app_id\`,\`end_user_id\`,\`used_at\`)`,
    `CREATE INDEX \`charge_correction_day\` ON \`charge\` (\`usage_day\`) WHERE kind = 'correction'`,
    `CREATE INDEX \`charge_corrects\` ON \`charge\` (\`corrects_charge_id\`)`,
    `CREATE INDEX \`charge_job_estimates\` ON \`charge\` (\`account_id\`,\`app_id\`,"used_at" DESC,\`owner_id\`) WHERE owner_type = 'job' AND kind = 'estimate'`,
    `CREATE INDEX \`charge_owner\` ON \`charge\` (\`owner_type\`,\`owner_id\`)`,
    `CREATE INDEX \`charge_usage_day\` ON \`charge\` (\`usage_day\`)`,
    `CREATE INDEX \`open_work_due\` ON \`open_work\` (\`due_at\`)`,
    `CREATE INDEX \`open_work_gave_up\` ON \`open_work\` (\`gave_up_at\`) WHERE gave_up_at IS NOT NULL`,
    `CREATE INDEX \`open_work_owner\` ON \`open_work\` (\`owner_type\`,\`owner_id\`)`,
    `CREATE INDEX \`session_app_started\` ON \`session\` (\`app_id\`,\`started_at\`)`,
    `CREATE INDEX \`session_started\` ON \`session\` (\`started_at\`)`,
    `CREATE INDEX \`usage_day_account\` ON \`usage_day\` (\`account_id\`,\`day\`)`,
    `CREATE INDEX \`usage_day_day\` ON \`usage_day\` (\`day\`)`,
    `CREATE INDEX \`usage_month_account\` ON \`usage_month\` (\`account_id\`,\`month\`)`,
    `CREATE TRIGGER charge_rollup_after_insert
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
  -- \`unpriced_charges\`, in the row it was counted in (a correction is dated
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
END`,
  ],
  // Version 2 (step 8f, Sol round 6): the next work still being tried, without reading given-up rows.
  ["CREATE INDEX `open_work_due_pending` ON `open_work` (`due_at`) WHERE gave_up_at IS NULL"],
  // Version 3 (step 9a part 2, Sol rounds 1 and 2): a live session's price, saved when it
  // opens, so a rate change mid-session never reprices it (`src/relay/session-price.ts`).
  // NULL: not saved yet; '': the model had no price; else the resolved price as JSON.
  ["ALTER TABLE `session` ADD COLUMN `rates_json` text"],
];
