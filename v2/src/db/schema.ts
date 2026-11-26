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

/**
 * The account activation v2 wrote before email verification became a mark on
 * the address. Nothing reads or writes it any more; a later migration drops it,
 * once every deployment runs a Worker that no longer writes it.
 */
export const accountActivation = sqliteTable("account_activation", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => mgmtOrganization.id, { onDelete: "cascade" }),
  activatedAt: integer("activated_at").notNull(),
});

/**
 * Addresses waiting to be verified: written, lower-cased, by a password
 * sign-up while the deployment verifies addresses, before the person or their
 * account exists. An account's app traffic waits while every active owner's
 * address is marked here and not verified (`../core/account-standing.ts`).
 */
export const emailPendingVerification = sqliteTable("email_pending_verification", {
  email: text("email").primaryKey(),
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

/**
 * The id of every app deleted, so no new app is ever given it (step 7b-4).
 * Rows that name an app by id alone (rollups, events, budget totals, stored
 * conversations) then never mix two apps' history. Never pruned: one short
 * row per deleted app.
 */
export const retiredAppId = sqliteTable("retired_app_id", {
  id: text("id").primaryKey(),
  retiredAt: integer("retired_at").notNull(),
});

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
     * For a gateway serving many providers (Vercel AI Gateway): the serving
     * providers it may use, pinned on every request by the gateway, over the
     * app's own value (v1's `providerOnly`, D13). A JSON list, or null.
     */
    servingProviders: text("serving_providers_json", { mode: "json" }).$type<string[]>(),
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

export type SplitKeyMode = "off" | "migrating" | "on";

/**
 * An account's split-key root (plan step 8j): only its public key. The root
 * key itself exists only inside keyslots. No row means split keys are off,
 * as for every account until it turns them on.
 */
export const accountKeyRoot = sqliteTable(
  "account_key_root",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => mgmtOrganization.id),
    /** X25519, base64url. New provider keys of the account are sealed to it. */
    publicKey: text("public_key").notNull(),
    mode: text("mode").$type<SplitKeyMode>().notNull(),
    /** Progress of a move between modes, once that exists (phase 4). */
    migration: text("migration_json", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("account_key_root_mode", oneOf(table.mode, ["off", "migrating", "on"]))],
);

/** What holds a keyslot: an app key now; iOS shares and passkeys in later phases. */
export type KeySlotCredentialKind = "api_key" | "ios_share" | "passkey";

/**
 * A keyslot: the account's root key sealed to one credential's public key,
 * inside the KEK (plan step 8j). Only a request that brings that credential
 * can open it.
 */
export const keySlot = sqliteTable(
  "key_slot",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    credentialKind: text("credential_kind").$type<KeySlotCredentialKind>().notNull(),
    /** The app key's id, for `api_key`. */
    credentialId: text("credential_id").notNull(),
    /** The credential's X25519 public key, base64url. */
    publicKey: text("public_key").notNull(),
    /** The root key, sealed to the public key and then with the KEK (vault kind `keySlot`). */
    sealedRoot: text("sealed_root").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("key_slot_credential").on(table.credentialKind, table.credentialId),
    index("key_slot_account").on(table.accountId),
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
    /**
     * When an issuer token for this user was first refused for a missing
     * entitlement claim, until a sign-in of theirs succeeds: how long a paid
     * entitlement takes to reach the issuer. Measurement only, as v1.
     */
    claimPendingSince: integer("claim_pending_since"),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.id] }),
    check("app_end_user_status", oneOf(table.status, ["active", "blocked"])),
    // The users still waiting on a claim, counted by the auth-event summary straight
    // from the index: active ones whose wait began inside the retention window.
    index("app_end_user_claim_pending").on(table.appId, table.status, table.claimPendingSince).where(sql`${table.claimPendingSince} IS NOT NULL`),
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
// The ledger's tables (charges, rollups, budgets, open work, sessions, and
// sign-in and rejection events) live in each account's ledger object, not in
// D1 (D21, step 8f): `../ledger/schema.ts`.

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
