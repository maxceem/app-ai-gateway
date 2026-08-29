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
/**
 * Gateway types the `provider_gateways_type_check` CHECK admits. The DB is
 * deliberately the wider of the two: widening it is a table rebuild, so the
 * whole planned set was admitted in one wave. Runtime is authoritative — see
 * {@link ProviderGatewayType}.
 */
export const PROVIDER_GATEWAY_TYPE_NAMES = ["cf_aig", "vercel"] as const;
export type ProviderGatewayTypeName = (typeof PROVIDER_GATEWAY_TYPE_NAMES)[number];
/**
 * Gateway types that actually have an adapter, and so are the only ones that
 * can be created or can serve traffic. A name the database admits but no
 * adapter implements is rejected by the contracts, never by the CHECK.
 */
export type ProviderGatewayType = "cf_aig";
/** Non-secret configuration for the org's own Cloudflare AI Gateway. */
export interface CfAigConfig {
  accountId: string;
  gatewayId: string;
}
/**
 * What `provider_gateway.config_json` holds. `cf_aig` is the only gateway type
 * with an adapter, so this is one shape today; it becomes a union discriminated
 * by the row's `type` when the Vercel adapter lands.
 */
export type ProviderGatewayConfig = CfAigConfig;
/**
 * What `provider.gateway_route_json` holds: how one provider row is routed
 * inside its gateway. The referenced `provider_gateway.type` selects the schema,
 * and the owning adapter validates it — `cf_aig` accepts nothing at all.
 */
export interface GatewayRouteConfig {
  /** Namespace the gateway expects in front of the canonical model ID. */
  modelPrefix?: string;
  /** Serving providers the gateway may pick from, where it supports pinning. */
  providerOnly?: string[];
}
/** Per-1M-token overrides for models the shipped catalog does not cover. */
export type ProviderPricing = Record<string, { input: number; output: number }>;
export type UsageStatus =
  | "ok"
  | "provider_error"
  | "blocked_rate"
  | "blocked_budget"
  | "blocked_user";
/**
 * Where a proxied request's `cost_usd` came from. `reported` is the upstream's
 * own figure for that request, which outranks a local estimate because it is
 * definitionally what the operator was charged; `computed` is this deployment's
 * price catalog; `unresolved` marks a successful provider response whose cost
 * neither source could establish, so its zero cost is an unknown rather than a
 * measurement.
 */
export type CostSource = "computed" | "reported" | "unresolved";
/**
 * Whose credential paid for a request, recorded only where the configuration
 * settles it. `direct` is the organization's own provider key; `byok` is that
 * same key held in a gateway's own key store; `gateway_system` is the gateway's
 * pooled credential. Never inferred from a successful response.
 */
export type CredentialSource = "direct" | "byok" | "gateway_system" | "unknown";

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
    type: text("type").$type<ProviderGatewayTypeName>().notNull(),
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
    // Mirrors PROVIDER_GATEWAY_TYPE_NAMES; widening one means a table rebuild,
    // which is why the whole planned set was admitted at once.
    check("provider_gateways_type_check", sql`${table.type} IN ('cf_aig', 'vercel')`),
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
    /**
     * How this row is routed inside its gateway. Null on a direct row and on
     * every gateway whose adapter needs no routing configuration; the adapter
     * named by `provider_gateway.type` validates the shape.
     */
    gatewayRoute: text("gateway_route_json", { mode: "json" }).$type<GatewayRouteConfig>(),
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
    // Deliberately wider than PROVIDER_TYPES in src/core/providers.ts: widening
    // it is a table rebuild, so every type on the roadmap was admitted in one
    // wave. A type with no registry entry is rejected by the contracts long
    // before it reaches this CHECK — the database is permissive, the runtime
    // registry is authoritative.
    check(
      "providers_type_check",
      sql`${table.type} IN (
        'openai', 'anthropic', 'xai', 'gemini', 'perplexity',
        'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'openrouter',
        'cerebras', 'moonshot', 'huggingface', 'baseten', 'bytedance'
      )`,
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
    /**
     * The gateway row the request was routed through, or null for a direct
     * call. Not a foreign key, for the same reason `provider_id` is not: a
     * gateway can be deleted, and the history must keep its attribution.
     */
    providerGatewayId: text("provider_gateway_id"),
    /** That gateway's type at request time, so history survives a rename. */
    providerGatewayType: text("provider_gateway_type").$type<ProviderGatewayTypeName>(),
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
    /**
     * What the upstream said the request cost, where the route reports one. It
     * is recorded next to `cost_usd` rather than instead of it, so a reported
     * figure and the locally computed one can always be compared.
     */
    reportedCostUsd: real("reported_cost_usd"),
    /** Serving provider the upstream named, when it names one. Never inferred. */
    servedProvider: text("served_provider"),
    /** Serving model the upstream named, canonicalized by the owning adapter. */
    servedModel: text("served_model"),
    /**
     * Whose key paid, where the configuration settles it. Unconstrained text
     * for the same reason `cost_source` is: new values must not rebuild a
     * populated table.
     */
    credentialSource: text("credential_source").$type<CredentialSource>(),
    /**
     * Who made the model, resolved when the event is recorded. An analytics
     * dimension only — never a budget or an allowlist — and re-derivable, the
     * way the reprice endpoint rewrites `cost_usd`.
     */
    modelAuthor: text("model_author"),
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
