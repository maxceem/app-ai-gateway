-- Records where a usage event's cost came from, so a successful provider
-- response whose usage shape the gateway cannot read is stored as `unresolved`
-- instead of being indistinguishable from a genuine zero. Additive and
-- unconstrained: existing rows keep a NULL `cost_source`, and later cost
-- sources are new values rather than a CHECK change that rebuilds the table.
ALTER TABLE `app_usage_event` ADD `cost_source` text;
