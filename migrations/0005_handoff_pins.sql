-- Gives the server's own handoff fields columns of their own: the payload
-- digest, the pinned target and gateway revisions, and the snapshots the
-- approval page shows. They were fields inside `request_json`, mixed in with
-- the payload the CLI sent.
--
-- Every column is nullable, because migrations run before the new Worker is
-- deployed and the Worker still serving until then inserts rows without them.
-- A resource handoff with no digest is refused at approval by the new Worker,
-- so such a row can only be started again from the CLI, never approved.
ALTER TABLE `mgmt_handoff` ADD `request_hash` text;--> statement-breakpoint
ALTER TABLE `mgmt_handoff` ADD `target_id` text;--> statement-breakpoint
ALTER TABLE `mgmt_handoff` ADD `target_revision` integer;--> statement-breakpoint
ALTER TABLE `mgmt_handoff` ADD `gateway_id` text;--> statement-breakpoint
ALTER TABLE `mgmt_handoff` ADD `gateway_revision` integer;--> statement-breakpoint
ALTER TABLE `mgmt_handoff` ADD `snapshot_json` text;