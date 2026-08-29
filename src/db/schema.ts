import { sql } from "drizzle-orm";
import { createCfAuthTables } from "@maxceem/cf-auth/schema";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ProviderType, StoredAppConfig } from "../core/types";

export type AppStatus = "active" | "disabled";
export type UserStatus = "active" | "blocked";
export type AuthMethod = "attest" | "api_key";
export type ApiKeyStatus = "active" | "revoked";
export type ProviderStatus = "active" | "revoked";
export type ProviderGatewayStatus = "active" | "revoked";
export type ProviderGatewayType = "cf_aig";
/** Non-secret configuration for the org's own Cloudflare AI Gateway. */
export interface CfAigConfig {
  accountId: string;
  gatewayId: string;
}
/**
 * What `provider_gateway.config_json` holds. `cf_aig` is the only gateway type
 * the CHECK constraint admits, so this is one shape today; it becomes a union
 * discriminated by the row's `type` when a second gateway lands.
 */
export type ProviderGatewayConfig = CfAigConfig;
/** Per-1M-token overrides for models the shipped catalog does not cover. */
export type ProviderPricing = Record<string, { input: number; output: number }>;
export type UsageStatus =
  | "ok"
  | "provider_error"
  | "blocked_rate"
  | "blocked_budget"
  | "blocked_user";
/**
 * Where a proxied request's `cost_usd` came from. `unresolved` marks a
 * successful provider response whose usage this deployment could not read, so
 * its zero cost is an unknown rather than a measurement.
 */
export type CostSource = "computed" | "unresolved";

/** Console-plane auth tables are namespaced away from end-user gateway data. */
export const consoleAuthTables = createCfAuthTables({ tablePrefix: "console_" });
export const {
  user: consoleUser,
  session: consoleUserSession,
  account: consoleUserAccount,
  verification: consoleVerification,
  organization: consoleOrganization,
  organizationUser: consoleOrganizationUser,
  apiKey: consoleApiKey,
} = consoleAuthTables;

export const app = sqliteTable(
  "app",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => consoleOrganization.id),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" })
      .$type<StoredAppConfig>()
      .notNull(),
    status: text("status").$type<AppStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_apps_organization_id").on(table.organizationId),
    check("apps_status_check", sql`${table.status} IN ('active', 'disabled')`),
  ],
);

/** A reusable connection to an organization's Cloudflare AI Gateway. */
export const providerGateway = sqliteTable(
  "provider_gateway",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => consoleOrganization.id),
    type: text("type").$type<ProviderGatewayType>().notNull(),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" }).$type<ProviderGatewayConfig>().notNull(),
    /** Vault blob for the gateway token; never leaves the server. */
    secretBlob: text("secret_blob").notNull(),
    secretHint: text("secret_hint").notNull(),
    status: text("status").$type<ProviderGatewayStatus>().notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_provider_gateways_organization").on(table.organizationId),
    check("provider_gateways_type_check", sql`${table.type} = 'cf_aig'`),
    check(
      "provider_gateways_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
  ],
);

/** One row = one named provider instance configured by an organization. */
export const provider = sqliteTable(
  "provider",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => consoleOrganization.id),
    type: text("type").$type<ProviderType>().notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Vault blob (`cfkms-env1.…` or `local1.…`); never leaves the server. */
    secretBlob: text("secret_blob"),
    /** Last four characters of the plaintext — the only fragment ever shown again. */
    secretHint: text("secret_hint"),
    providerGatewayId: text("provider_gateway_id")
      .references(() => providerGateway.id),
    pricing: text("pricing_json", { mode: "json" }).$type<ProviderPricing>(),
    status: text("status").$type<ProviderStatus>().notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_providers_organization").on(table.organizationId),
    uniqueIndex("providers_active_slug_unique")
      .on(table.organizationId, table.slug)
      .where(sql`${table.status} = 'active'`),
    check("providers_status_check", sql`${table.status} IN ('active', 'revoked')`),
    // Mirrors PROVIDER_TYPES in src/core/providers.ts; widening one means a migration.
    check(
      "providers_type_check",
      sql`${table.type} IN ('openai', 'anthropic', 'xai', 'gemini', 'perplexity')`,
    ),
    check(
      "providers_secret_source_check",
      sql`(${table.providerGatewayId} IS NULL) = (${table.secretBlob} IS NOT NULL)`,
    ),
  ],
);

export const appApiKey = sqliteTable(
  "app_api_key",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    status: text("status").$type<ApiKeyStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    index("idx_api_keys_app").on(table.appId),
    uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
    check("api_keys_status_check", sql`${table.status} IN ('active', 'revoked')`),
  ],
);

export const appUser = sqliteTable(
  "app_user",
  {
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    id: text("id").notNull(),
    attestKeyId: text("attest_key_id"),
    attestPublicKey: text("attest_public_key"),
    attestCounter: integer("attest_counter").notNull().default(0),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastSeenAt: text("last_seen_at"),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.id] }),
    check("users_status_check", sql`${table.status} IN ('active', 'blocked')`),
  ],
);

export const appUsageEvent = sqliteTable(
  "app_usage_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * Recording identity, generated once per event and reused by every retry so
     * the insert can be replayed without duplicating the row. Null on rows
     * written before recording became idempotent; SQLite's unique index treats
     * each NULL as distinct, so those rows coexist.
     */
    eventId: text("event_id"),
    appId: text("app_id").notNull(),
    userId: text("user_id").notNull(),
    apiKeyId: text("api_key_id"),
    providerType: text("provider_type").notNull(),
    /**
     * The provider row that served the traffic. Deliberately not a foreign key:
     * deleting a provider is a hard delete, and usage history must survive it
     * with its attribution intact. Null for traffic blocked before resolution.
     */
    providerId: text("provider_id"),
    /** Provider instance slug at request time; survives row deletion or reuse. */
    providerSlug: text("provider_slug"),
    model: text("model").notNull(),
    route: text("route").notNull(),
    endpointSlug: text("endpoint_slug"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    /**
     * How `cost_usd` was arrived at, for events that reached a provider. Null on
     * blocked traffic, which never had a cost to source, and on rows written
     * before the column existed. Deliberately unconstrained text: the value set
     * grows as new cost sources land, and a CHECK on this table would make each
     * addition a full rebuild.
     */
    costSource: text("cost_source").$type<CostSource>(),
    appVersion: text("app_version"),
    authMethod: text("auth_method").$type<AuthMethod>(),
    status: text("status").$type<UsageStatus>().notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_usage_user_month").on(table.appId, table.userId, table.createdAt),
    index("idx_usage_app_month").on(table.appId, table.createdAt),
    uniqueIndex("usage_events_event_id_unique").on(table.eventId),
    check(
      "usage_events_status_check",
      sql`${table.status} IN ('ok', 'provider_error', 'blocked_rate', 'blocked_budget', 'blocked_user')`,
    ),
  ],
);

export const appAuthChallenge = sqliteTable(
  "app_auth_challenge",
  {
    challenge: text("challenge").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_auth_challenges_expiry").on(table.expiresAt)],
);
