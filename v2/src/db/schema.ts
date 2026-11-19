/**
 * The v2 D1 schema.
 *
 * Rules for every table here:
 *
 * - Times are integers: milliseconds since 1970-01-01 UTC. Days are text,
 *   `YYYY-MM-DD`, in UTC.
 * - Money is an integer number of nano-dollars (1 = $0.000000001), in columns
 *   named `*_nano`. Rates are integer nano-dollars per million units. Never a
 *   float (plan D20).
 * - Ids are text. v1's id formats are accepted as they are, so the migration
 *   keeps every id (see `v2-prep/v1-v2-table-map.md`, 3.4).
 * - A value list that may grow is typed in TypeScript but not checked by the
 *   database, because changing a CHECK in SQLite means rebuilding the table.
 *   Lists the plan fixes (the ledger labels) are checked.
 *
 * Table names: `mgmt_` tables belong to sign-in (cf-auth). A bare noun is
 * something the account sets up. `app_` rows belong to an app. The ledger
 * tables are `charge`, `usage_day`, `budget_day` and `open_work`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createCfAuthTables } from "@maxceem/cf-auth/schema";
import {
  BUDGET_SCOPES,
  CHARGE_KINDS,
  CORRECTION_KINDS,
  MEASURED,
  OPEN_WORK_KINDS,
  OWNER_TYPES,
  PRICE_SOURCES,
  type BudgetScope,
  type ChargeKind,
  type ChargeStatus,
  type CorrectionKind,
  type Measured,
  type OpenWorkKind,
  type OwnerType,
  type PriceSource,
} from "../ledger/labels.ts";

/** `col IN ('a', 'b')` for a CHECK, from one of the fixed lists. */
function oneOf(column: unknown, values: readonly string[]) {
  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

// ---------------------------------------------------------------------------
// Accounts and sign-in

/**
 * Sign-in tables from cf-auth: people, their sign-in methods and sessions,
 * accounts ("organizations" in cf-auth), members, invitations, management keys
 * and OAuth tokens. v2 starts on cf-auth 0.11.1. cf-auth 1.0 (before step 2)
 * changes these tables in its own migration.
 */
export const mgmtAuthTables = createCfAuthTables({ tablePrefix: "mgmt_" });
export const {
  user: mgmtUser,
  session: mgmtUserSession,
  account: mgmtUserAccount,
  verification: mgmtVerification,
  organization: mgmtOrganization,
  organizationUser: mgmtOrganizationUser,
  apiKey: mgmtApiKey,
  operation: mgmtOperation,
  oauthToken: mgmtOauthToken,
  organizationInvitation: mgmtOrganizationInvitation,
} = mgmtAuthTables;

/** Accounts allowed to serve traffic before their owner's email is verified. */
export const accountActivation = sqliteTable("account_activation", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => mgmtOrganization.id, { onDelete: "cascade" }),
  activatedAt: integer("activated_at").notNull(),
});

// ---------------------------------------------------------------------------
// What an account sets up

export type AppStatus = "active" | "disabled";

/**
 * An app. Its settings (allowed providers and operations, presets, limits,
 * authentication) are one JSON document, checked when it is saved. Its shape
 * is defined with the management API in step 1a part 3.
 */
export const app = sqliteTable(
  "app",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Goes up by one on every saved change, so two editors cannot overwrite each other. */
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<AppStatus>().notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("app_account").on(table.accountId),
    check("app_status", oneOf(table.status, ["active", "disabled"])),
  ],
);

export type ProviderConnectionStatus = "active" | "disabled";

/**
 * A provider connection: a built-in provider with the account's key, a
 * Vercel AI Gateway connection, or a custom provider (plan D10, D13).
 *
 * The key is sealed by the vault and never returned, only its hint.
 * `type` names a built-in provider description, or `custom`.
 */
export const providerConnection = sqliteTable(
  "provider_connection",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    type: text("type").notNull(),
    /** The name used in request paths: `/v2/apps/{app}/proxy/{slug}/...`. Unique per account. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<ProviderConnectionStatus>().notNull().default("active"),
    secretBlob: text("secret_blob"),
    secretHint: text("secret_hint"),
    /**
     * A different host for a built-in provider (self-hosted servers, regional
     * hosts, Azure OpenAI), priced from our price list. For a custom provider,
     * its only host. Checked by the origin guard when saved.
     */
    baseUrl: text("base_url"),
    /**
     * Sending this connection's traffic through Cloudflare AI Gateway: account
     * id, gateway id, and its own sealed token and hint (D13).
     */
    cloudflareGateway: text("cloudflare_gateway_json", { mode: "json" }).$type<Record<string, unknown>>(),
    /** The customer's own rates, in nano-dollars per million units, keyed by model. */
    rates: text("rates_json", { mode: "json" }).$type<Record<string, unknown>>(),
    /**
     * Listed passthrough paths, and for a custom provider how its key is sent
     * and which API style each path speaks (plan section 4.5).
     */
    passthrough: text("passthrough_json", { mode: "json" }).$type<Record<string, unknown>>(),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_connection_slug").on(table.accountId, table.slug),
    check("provider_connection_status", oneOf(table.status, ["active", "disabled"])),
  ],
);

export type AppKeyStatus = "active" | "revoked";

/** An app key, for server apps. Only its SHA-256 hash is stored. */
export const appKey = sqliteTable(
  "app_key",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    /** The first characters of the key, shown so a person can tell keys apart. */
    keyPrefix: text("key_prefix").notNull(),
    status: text("status").$type<AppKeyStatus>().notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    index("app_key_app").on(table.appId),
    uniqueIndex("app_key_hash").on(table.keyHash),
    check("app_key_status", oneOf(table.status, ["active", "revoked"])),
  ],
);

export type EndUserStatus = "active" | "blocked";

/** An end user of an app, as the app's own sign-in names them. */
export const appEndUser = sqliteTable(
  "app_end_user",
  {
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    id: text("id").notNull(),
    status: text("status").$type<EndUserStatus>().notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.id] }),
    check("app_end_user_status", oneOf(table.status, ["active", "blocked"])),
  ],
);

export type AttestEnvironment = "production" | "development";

/** A registered App Attest key: one per app install. Its replay counter lives in the end user's limiter object. */
export const appAttestKey = sqliteTable(
  "app_attest_key",
  {
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    keyId: text("key_id").notNull(),
    /** SPKI, PEM-encoded. */
    publicKey: text("public_key").notNull(),
    environment: text("environment").$type<AttestEnvironment>().notNull(),
    userId: text("user_id"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.keyId] }),
    index("app_attest_key_user").on(table.appId, table.userId),
    check("app_attest_key_environment", oneOf(table.environment, ["production", "development"])),
  ],
);

// ---------------------------------------------------------------------------
// The ledger (plan section 4.2)

/**
 * One row per charge, the source of truth for usage and money.
 *
 * - A row is never changed after it is written. A correction is a new row
 *   with only the difference.
 * - A failed attempt that cost nothing has `cost_nano` NULL, not 0. The
 *   console and the CLI show it as "—". SQLite's SUM skips NULL.
 * - Writing a row whose id already exists is ignored, so a retried write never
 *   counts twice. The rollup trigger (step 1a part 3) runs only for rows
 *   really inserted. Write with `ON CONFLICT(id) DO NOTHING`, never
 *   `INSERT OR IGNORE`: that would also silently drop a row that breaks a
 *   CHECK, and the charge would be lost without an error.
 */
export const charge = sqliteTable(
  "charge",
  {
    /** Stable id. A retry of the same write uses the same id. */
    id: text("id").primaryKey(),
    kind: text("kind").$type<ChargeKind>().notNull(),

    accountId: text("account_id").notNull(),
    appId: text("app_id").notNull(),
    /** The end user, install, Apple Account and app key, where the request had them. */
    endUserId: text("end_user_id"),
    installId: text("install_id"),
    appleAccountId: text("apple_account_id"),
    appKeyId: text("app_key_id"),

    /**
     * What the charge belongs to: a call (all attempts of one request), a
     * session, or a job. There is one settlement per owner.
     */
    ownerType: text("owner_type").$type<OwnerType>().notNull(),
    ownerId: text("owner_id").notNull(),
    /** The attempt's place in a fallback chain, or the slice number in a session. Starts at 1. */
    seq: integer("seq"),

    /** Kept even after the connection is deleted, when `provider_connection_id` points nowhere. */
    providerType: text("provider_type").notNull(),
    providerConnectionId: text("provider_connection_id"),
    /** The declared operation, such as `openai.chat`, or `passthrough`. */
    operation: text("operation").notNull(),
    preset: text("preset"),
    model: text("model"),

    status: text("status").$type<ChargeStatus>().notNull(),
    /** The provider's HTTP status, where there was one. */
    httpStatus: integer("http_status"),
    /** The provider's own error code, such as `rate_limit_exceeded`. */
    errorCode: text("error_code"),

    /** Integer nano-dollars. NULL means nothing was billed, shown as "—". */
    costNano: integer("cost_nano"),
    measured: text("measured").$type<Measured>().notNull(),
    priceSource: text("price_source").$type<PriceSource>().notNull(),
    /**
     * The price is the closest known one, not the exact one, such as a service
     * mode with no price billed at the model's standard price (AGENTS.md).
     * Shown to the customer as an estimate.
     */
    priceIsEstimate: integer("price_is_estimate", { mode: "boolean" }).notNull().default(false),

    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    outputTokens: integer("output_tokens"),
    /**
     * The model's main billed unit and how many of it (tokens, characters,
     * seconds, images), so rollups keep it after detailed rows are compacted.
     * Fractional units are stored at a fixed scale per unit.
     */
    unit: text("unit"),
    units: integer("units"),
    /** All measures, including the ones above, as integers at a fixed scale per unit (D7). */
    measures: text("measures_json", { mode: "json" }).$type<Record<string, number>>().notNull(),
    /** The rates used to price this charge, in nano-dollars per million units. A units correction uses them. */
    rates: text("rates_json", { mode: "json" }).$type<Record<string, number>>(),
    /**
     * A session slice's connection time through the gateway, in milliseconds.
     * Plan minutes are the sum of this. Corrections never set it.
     */
    sessionMs: integer("session_ms"),

    /** Only on corrections. */
    correctionKind: text("correction_kind").$type<CorrectionKind>(),
    /** The charge a correction settles or prices. NULL for a session-level or job-level correction. */
    correctsChargeId: text("corrects_charge_id"),

    latencyMs: integer("latency_ms"),
    appVersion: text("app_version"),
    authMethod: text("auth_method"),
    /** The app's own trace id. Stored conversations join on it. */
    clientTraceId: text("client_trace_id"),

    /** When the usage happened. Rollups, budgets and plan periods use this. */
    usedAt: integer("used_at").notNull(),
    /** `used_at` as a UTC day. */
    usageDay: text("usage_day").notNull(),
    /** When the row was written. */
    writtenAt: integer("written_at").notNull(),
  },
  (table) => [
    index("charge_app_used").on(table.appId, table.usedAt),
    index("charge_account_used").on(table.accountId, table.usedAt),
    index("charge_owner").on(table.ownerType, table.ownerId),
    index("charge_corrects").on(table.correctsChargeId),
    check("charge_kind", oneOf(table.kind, CHARGE_KINDS)),
    check("charge_owner_type", oneOf(table.ownerType, OWNER_TYPES)),
    check("charge_measured", oneOf(table.measured, MEASURED)),
    check("charge_price_source", oneOf(table.priceSource, PRICE_SOURCES)),
    check(
      "charge_correction",
      sql`(${table.kind} = 'correction') = (${table.correctionKind} IS NOT NULL)
        AND (${table.correctionKind} IS NULL OR ${oneOf(table.correctionKind, CORRECTION_KINDS)})`,
    ),
    check("charge_corrects_only_corrections", sql`${table.correctsChargeId} IS NULL OR ${table.kind} = 'correction'`),
    check("charge_session_ms", sql`${table.sessionMs} IS NULL OR ${table.kind} = 'slice'`),
    check("charge_usage_day", sql`length(${table.usageDay}) = 10`),
    // SQLite would store 1.5 in an INTEGER column as a float. Money is whole nano-dollars (D20).
    check("charge_cost_integer", sql`${table.costNano} IS NULL OR typeof(${table.costNano}) = 'integer'`),
  ],
);

/**
 * Usage summed per app and UTC day, kept by a trigger on `charge` (built in
 * step 1a part 3). The console's charts and plan minutes read it, and it
 * survives compaction of detailed rows.
 *
 * Key parts that can be missing are '' rather than NULL, because NULLs never
 * collide in a SQLite key.
 */
export const usageDay = sqliteTable(
  "usage_day",
  {
    accountId: text("account_id").notNull(),
    appId: text("app_id").notNull(),
    day: text("day").notNull(),
    providerType: text("provider_type").notNull(),
    providerConnectionId: text("provider_connection_id").notNull(),
    model: text("model").notNull(),
    /** `ok` or `failed`, so failed attempts can be counted without reading charges. */
    outcome: text("outcome").$type<"ok" | "failed">().notNull(),
    unit: text("unit").notNull(),

    /** Rows that are not corrections. */
    charges: integer("charges").notNull().default(0),
    /** Of those, rows with no price yet or no price at all. */
    unpricedCharges: integer("unpriced_charges").notNull().default(0),
    costNano: integer("cost_nano").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    units: integer("units").notNull().default(0),
    sessionMs: integer("session_ms").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.appId,
        table.day,
        table.providerType,
        table.providerConnectionId,
        table.model,
        table.outcome,
        table.unit,
      ],
    }),
    index("usage_day_account").on(table.accountId, table.day),
    check("usage_day_outcome", oneOf(table.outcome, ["ok", "failed"])),
    check("usage_day_cost_integer", sql`typeof(${table.costNano}) = 'integer'`),
  ],
);

/**
 * Dollars and session time per budget scope and UTC day, kept by the same
 * trigger. The limiter objects read their cached budget totals from here
 * every 10 s (step 1b). `scope_id` is the app id for the `app` scope.
 */
export const budgetDay = sqliteTable(
  "budget_day",
  {
    appId: text("app_id").notNull(),
    scope: text("scope").$type<BudgetScope>().notNull(),
    scopeId: text("scope_id").notNull(),
    day: text("day").notNull(),
    costNano: integer("cost_nano").notNull().default(0),
    sessionMs: integer("session_ms").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.scope, table.scopeId, table.day] }),
    check("budget_day_scope", oneOf(table.scope, BUDGET_SCOPES)),
    check("budget_day_cost_integer", sql`typeof(${table.costNano}) = 'integer'`),
  ],
);

/**
 * Work the sweep still has to do. A row is written in the same D1 batch as
 * its charge, and removed when its work is done (plan section 4.2).
 */
export const openWork = sqliteTable(
  "open_work",
  {
    /** Made from what the work is about, so writing it twice is ignored. */
    id: text("id").primaryKey(),
    kind: text("kind").$type<OpenWorkKind>().notNull(),
    accountId: text("account_id").notNull(),
    appId: text("app_id").notNull(),
    ownerType: text("owner_type").$type<OwnerType>().notNull(),
    ownerId: text("owner_id").notNull(),
    chargeId: text("charge_id"),
    /** What the work needs, such as a provider request id. */
    detail: text("detail_json", { mode: "json" }).$type<Record<string, unknown>>(),
    dueAt: integer("due_at").notNull(),
    tries: integer("tries").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("open_work_due").on(table.dueAt),
    index("open_work_owner").on(table.ownerType, table.ownerId),
    check("open_work_kind", oneOf(table.kind, OPEN_WORK_KINDS)),
    check("open_work_owner_type", oneOf(table.ownerType, OWNER_TYPES)),
  ],
);

// ---------------------------------------------------------------------------
// App sign-in (step 1a part 2)

/**
 * App Attest challenges, valid for five minutes and spent once. Who asked is
 * kept beside the challenge, so an expired one can still be recorded as an
 * `abandoned` auth event.
 */
export const appAuthChallenge = sqliteTable(
  "app_auth_challenge",
  {
    challenge: text("challenge").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    expiresAt: integer("expires_at").notNull(),
    appVersion: text("app_version"),
    clientSdk: text("client_sdk"),
    networkAsn: integer("network_asn"),
    networkName: text("network_name"),
    /** A register, token or failure call named this challenge, so its expiry is not counted as abandoned. */
    attempted: integer("attempted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("app_auth_challenge_expiry").on(table.expiresAt)],
);

/** The events `app_auth_event.event` records. */
export type AuthEventName = "challenge" | "register" | "token_exchange";

/**
 * One row per app sign-in attempt (challenge outcome, key registration or
 * token exchange), successful or refused. Kept 90 days. `outcome` is `ok`, an
 * error code, or a challenge outcome; the list grows, so it is not checked.
 */
export const appAuthEvent = sqliteTable(
  "app_auth_event",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull(),
    userId: text("user_id"),
    event: text("event").$type<AuthEventName>().notNull(),
    authMethod: text("auth_method"),
    outcome: text("outcome").notNull(),
    /** A short token, such as an issuer rejection reason or a device step and error code. */
    reason: text("reason"),
    appVersion: text("app_version"),
    clientSdk: text("client_sdk"),
    networkAsn: integer("network_asn"),
    networkName: text("network_name"),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("app_auth_event_app_created").on(table.appId, table.createdAt),
    index("app_auth_event_app_user_created").on(table.appId, table.userId, table.createdAt),
    index("app_auth_event_created").on(table.createdAt),
  ],
);

/**
 * A provider request refused before it reached the provider, such as a model
 * the app does not allow. Sampled: at most one per minute per user and reason
 * for a settings refusal, and one per minute per user for the rest, as v1
 * does. Kept 90 days.
 */
export const appRejectionEvent = sqliteTable(
  "app_rejection_event",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").notNull(),
    userId: text("user_id"),
    installId: text("install_id"),
    appKeyId: text("app_key_id"),
    /** Why, such as `model_not_allowed`. A list that grows, so not checked. */
    reason: text("reason").notNull(),
    /** Whose limit refused it, where a limit did: `user`, `install`, `apple_account`, `app` or `account`. */
    scope: text("scope"),
    providerSlug: text("provider_slug"),
    model: text("model"),
    /** The declared operation, where the path matched one. */
    operation: text("operation"),
    appVersion: text("app_version"),
    authMethod: text("auth_method"),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("app_rejection_event_app_created").on(table.appId, table.createdAt),
    index("app_rejection_event_app_user_created").on(table.appId, table.userId, table.createdAt),
    index("app_rejection_event_created").on(table.createdAt),
  ],
);
