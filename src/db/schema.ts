import { sql } from "drizzle-orm";
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
import type { StoredAppConfig } from "../core/types";

export type AppStatus = "active" | "disabled";
export type UserStatus = "active" | "blocked";
export type AttestEnvironment = "production" | "development";
export type AuthMethod = "dev" | "attest" | "api_key";
export type ApiKeyStatus = "active" | "revoked";
export type UsageStatus =
  | "ok"
  | "provider_error"
  | "blocked_rate"
  | "blocked_budget"
  | "blocked_user";

export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" })
      .$type<StoredAppConfig>()
      .notNull(),
    status: text("status").$type<AppStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    check("apps_status_check", sql`${table.status} IN ('active', 'disabled')`),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
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

export const developmentCredentials = sqliteTable("development_credentials", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id),
  secretHash: text("secret_hash").notNull(),
  secretPrefix: text("secret_prefix").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  rotatedAt: text("rotated_at"),
});

export const users = sqliteTable(
  "users",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    id: text("id").notNull(),
    attestKeyId: text("attest_key_id"),
    attestPublicKey: text("attest_public_key"),
    attestCounter: integer("attest_counter").notNull().default(0),
    attestEnvironment: text("attest_env").$type<AttestEnvironment>(),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastSeenAt: text("last_seen_at"),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.id] }),
    check("users_status_check", sql`${table.status} IN ('active', 'blocked')`),
  ],
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: text("app_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    route: text("route").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    appVersion: text("app_version"),
    authMethod: text("auth_method").$type<AuthMethod>(),
    status: text("status").$type<UsageStatus>().notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_usage_user_month").on(table.appId, table.userId, table.createdAt),
    index("idx_usage_app_month").on(table.appId, table.createdAt),
    check(
      "usage_events_status_check",
      sql`${table.status} IN ('ok', 'provider_error', 'blocked_rate', 'blocked_budget', 'blocked_user')`,
    ),
  ],
);

export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    challenge: text("challenge").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_auth_challenges_expiry").on(table.expiresAt)],
);
