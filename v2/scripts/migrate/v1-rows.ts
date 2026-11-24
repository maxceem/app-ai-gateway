/**
 * The v1 rows the settings half of the migration reads, as a v1 database
 * export holds them, and the one place they are read from that export.
 *
 * A v1 export is what `wrangler d1 export` writes: SQL that creates every table
 * and inserts every row. It is loaded whole into an in-memory SQLite database
 * (`node:sqlite`), and read from there with plain SELECTs, so the script needs
 * no access to v1 at all.
 */
import { DatabaseSync } from "node:sqlite";

type Text = string;
type Nullable<T> = T | null;

export interface V1User {
  id: Text;
  name: Text;
  email: Nullable<Text>;
  kind: Text;
  email_verified: number;
  image: Nullable<Text>;
  created_at: number;
  updated_at: number;
}

export interface V1Login {
  id: Text;
  account_id: Text;
  provider_id: Text;
  user_id: Text;
  password: Nullable<Text>;
  created_at: number;
  updated_at: number;
}

export interface V1Account {
  id: Text;
  name: Text;
  expires_at: Nullable<Text>;
  created_by_user_id: Text;
  created_at: Text;
  updated_at: Text;
}

export interface V1Member {
  id: Text;
  organization_id: Text;
  user_id: Text;
  role: Text;
  status: Text;
  joined_at: Text;
  last_active_at: Nullable<Text>;
}

export interface V1Invitation {
  id: Text;
  organization_id: Text;
  email: Text;
  role: Text;
  token_hash: Text;
  invited_by_user_id: Nullable<Text>;
  created_at: Text;
  expires_at: Text;
  response: Nullable<Text>;
  responded_at: Nullable<Text>;
  responded_by_user_id: Nullable<Text>;
}

export interface V1ManagementKey {
  id: Text;
  user_id: Text;
  organization_id: Text;
  name: Text;
  token_hash: Text;
  token_hint: Text;
  enabled: number;
  expires_at: Nullable<number>;
  created_at: number;
  revoked_at: Nullable<number>;
  source: Text;
  label: Nullable<Text>;
  grant: Text;
  client_id: Nullable<Text>;
  resource: Nullable<Text>;
  credential_type: Text;
}

export interface V1App {
  id: Text;
  organization_id: Text;
  name: Text;
  config_json: Text;
  status: Text;
  created_at: Text;
  updated_at: Text;
}

export interface V1AppKey {
  id: Text;
  app_id: Text;
  name: Text;
  key_hash: Text;
  key_prefix: Text;
  status: Text;
  created_at: Text;
  last_used_at: Nullable<Text>;
}

export interface V1AttestKey {
  app_id: Text;
  key_id: Text;
  public_key: Text;
  environment: Text;
  user_id: Nullable<Text>;
  created_at: Text;
  last_seen_at: Text;
}

export interface V1Provider {
  id: Text;
  organization_id: Text;
  type: Text;
  slug: Text;
  name: Text;
  secret_blob: Nullable<Text>;
  secret_hint: Nullable<Text>;
  provider_gateway_id: Nullable<Text>;
  base_url: Nullable<Text>;
  gateway_route_json: Nullable<Text>;
  pricing_json: Nullable<Text>;
  status: Text;
  created_by: Text;
  created_at: Text;
  updated_at: Text;
}

export interface V1Gateway {
  id: Text;
  organization_id: Text;
  type: Text;
  name: Text;
  config_json: Text;
  secret_blob: Text;
  secret_hint: Text;
  status: Text;
}

/** Everything the settings half moves, read from one v1 export. */
export interface V1Settings {
  users: V1User[];
  logins: V1Login[];
  accounts: V1Account[];
  members: V1Member[];
  invitations: V1Invitation[];
  managementKeys: V1ManagementKey[];
  apps: V1App[];
  appKeys: V1AppKey[];
  attestKeys: V1AttestKey[];
  providers: V1Provider[];
  gateways: V1Gateway[];
  /** App ids v1 still names in its history, though the app is gone: never given out again in v2. */
  historyAppIds: string[];
}

/** The tables whose rows name app ids, for the ids of deleted apps. */
const HISTORY_TABLES = ["app_usage_event", "app_usage_rollup", "app_rejection_event", "app_auth_event"] as const;

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function rows<T>(db: DatabaseSync, table: string, sql = `SELECT * FROM ${table}`): T[] {
  if (!tableExists(db, table)) return [];
  return db.prepare(sql).all() as T[];
}

/** Reads every settings row from a v1 database. */
export function readV1Settings(db: DatabaseSync): V1Settings {
  const historyAppIds = new Set<string>();
  for (const table of HISTORY_TABLES) {
    if (!tableExists(db, table)) continue;
    for (const row of db.prepare(`SELECT DISTINCT app_id FROM ${table}`).all() as { app_id: string | null }[]) {
      if (typeof row.app_id === "string" && row.app_id !== "") historyAppIds.add(row.app_id);
    }
  }
  return {
    users: rows(db, "mgmt_user"),
    logins: rows(db, "mgmt_user_account"),
    accounts: rows(db, "mgmt_organization"),
    members: rows(db, "mgmt_organization_user"),
    invitations: rows(db, "mgmt_organization_invitation"),
    managementKeys: rows(db, "mgmt_api_key"),
    apps: rows(db, "app"),
    appKeys: rows(db, "app_api_key"),
    attestKeys: rows(db, "app_attest_key"),
    providers: rows(db, "provider"),
    gateways: rows(db, "provider_gateway"),
    historyAppIds: [...historyAppIds].sort(),
  };
}

/**
 * A v1 export, loaded into a fresh in-memory database. Foreign keys are not
 * enforced: an export writes each table's rows right after the table, so a
 * row can come before the table it refers to.
 */
export function loadV1Export(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(sql);
  return db;
}
