-- Every account that exists when email verification arrives could serve its
-- apps before it: it keeps doing so, whatever its owners' email (v1's rule,
-- AGENTS.md "Never start refusing something that used to work"). That covers
-- accounts made by `scripts/management-key.ts --create-account`, whose owner
-- is a key with no address to verify.
INSERT OR IGNORE INTO `account_activation` (`account_id`, `activated_at`)
SELECT `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM `mgmt_organization`;
