-- Drops `providers_type_check` and `provider_gateways_type_check`. SQLite has no
-- way to alter a CHECK, so both tables are rebuilt; the runtime registries
-- (`PROVIDER_DESCRIPTORS`, `ROUTE_ADAPTERS`) are what decide which names this
-- deployment can serve, and they always were — the CHECKs only made adding a
-- provider or a gateway type cost a rebuild like this one.
--
-- Hand-written, and a regenerated file would not reproduce it. What
-- `drizzle-kit generate` emits fails on a populated database, twice over, and
-- both fixes are in the statement order and the CHECK syntax below:
--
-- 1. Every CHECK here names its column unqualified. Drizzle qualifies them with
--    the temporary table name (`CHECK("__new_provider_gateway"."status" …)`),
--    and the later `ALTER TABLE … RENAME TO` re-parses the constraint under the
--    new name and fails with `no such column: __new_provider_gateway.status`.
--
-- 2. The new child references the *new* parent directly, and both old tables are
--    dropped only once both new ones are filled. Dropping the old parent while
--    the old child still references it is a foreign-key violation that survives
--    dropping the child afterwards — the child's rows are gone, but SQLite's
--    deferred-violation counter is not decremented by a drop, so the COMMIT
--    fails. `PRAGMA defer_foreign_keys` does not help, and `PRAGMA
--    foreign_keys` is a no-op inside the transaction D1 runs this file in.
--    Renaming `__new_provider_gateway` last rewrites `__new_provider`'s
--    REFERENCES clause to `provider_gateway` for us, so the finished schema is
--    the one the snapshot describes and `PRAGMA foreign_key_check` is empty.
--
-- Verified by applying 0000..0003 to a plain SQLite file, seeding a gateway with
-- both a routed and a direct provider, and running this file inside
-- `PRAGMA foreign_keys=ON; BEGIN; … COMMIT;` with no PRAGMA tricks at all.
CREATE TABLE `__new_provider_gateway` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`secret_blob` text NOT NULL,
	`secret_hint` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "provider_gateways_status_check" CHECK("status" IN ('active', 'revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_provider_gateway`("id", "organization_id", "type", "name", "config_json", "secret_blob", "secret_hint", "revision", "status", "created_by", "created_at", "updated_at") SELECT "id", "organization_id", "type", "name", "config_json", "secret_blob", "secret_hint", "revision", "status", "created_by", "created_at", "updated_at" FROM `provider_gateway`;--> statement-breakpoint
CREATE TABLE `__new_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`secret_blob` text,
	`secret_hint` text,
	`provider_gateway_id` text,
	`base_url` text,
	`gateway_route_json` text,
	`pricing_json` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `mgmt_organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_gateway_id`) REFERENCES `__new_provider_gateway`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "providers_status_check" CHECK("status" IN ('active', 'disabled')),
	CONSTRAINT "providers_secret_source_check" CHECK(("provider_gateway_id" IS NULL) = ("secret_blob" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_provider`("id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "base_url", "gateway_route_json", "pricing_json", "revision", "status", "created_by", "created_at", "updated_at") SELECT "id", "organization_id", "type", "slug", "name", "secret_blob", "secret_hint", "provider_gateway_id", "base_url", "gateway_route_json", "pricing_json", "revision", "status", "created_by", "created_at", "updated_at" FROM `provider`;--> statement-breakpoint
DROP TABLE `provider`;--> statement-breakpoint
DROP TABLE `provider_gateway`;--> statement-breakpoint
ALTER TABLE `__new_provider_gateway` RENAME TO `provider_gateway`;--> statement-breakpoint
ALTER TABLE `__new_provider` RENAME TO `provider`;--> statement-breakpoint
CREATE INDEX `idx_provider_gateways_organization` ON `provider_gateway` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_providers_organization` ON `provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_slug_unique` ON `provider` (`organization_id`,`slug`);
