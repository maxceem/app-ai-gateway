/**
 * The v1 rows the settings half of the migration reads, as a v1 database
 * export holds them, and the one place they are read from that export.
 *
 * A v1 export is what `wrangler d1 export` writes: SQL that creates every table
 * and inserts every row. It is read a piece at a time into a SQLite database
 * (`node:sqlite`) in a private temporary folder, so an export larger than
 * memory still loads, and read from there with plain SELECTs. The script needs
 * no access to v1 at all.
 */
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** Accounts v1 marked activated (`account_activation`), whatever their owners' addresses. */
  activatedAccountIds: string[];
  /** Per app, how many of its end users v1 blocked (`app_user.status`). */
  blockedUsers: Record<string, number>;
  /** Per app, the `slug/path` routes its usage shows it called, as v1 recorded them. */
  usageRoutes: Record<string, string[]>;
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
  const blockedUsers: Record<string, number> = {};
  for (const row of rows<{ app_id: string; n: number }>(db, "app_user", "SELECT app_id, COUNT(*) AS n FROM app_user WHERE status = 'blocked' GROUP BY app_id")) {
    blockedUsers[row.app_id] = row.n;
  }
  const usageRoutes: Record<string, string[]> = {};
  for (const row of rows<{ app_id: string; route: string | null }>(db, "app_usage_event", "SELECT DISTINCT app_id, route FROM app_usage_event WHERE route IS NOT NULL ORDER BY route")) {
    if (row.route !== null) (usageRoutes[row.app_id] ??= []).push(row.route);
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
    activatedAccountIds: rows<{ organization_id: string }>(db, "account_activation").map((row) => row.organization_id),
    blockedUsers,
    usageRoutes,
  };
}

/**
 * Splits SQL text into whole statements, a piece at a time: a `;` ends a
 * statement only outside a quoted string or name (`'…'`, `"…"`, `` `…` ``,
 * where a doubled quote stays inside) and outside a comment (`-- …` to the end
 * of the line, `/* … *\/`). Comments stay in the statement, which SQLite
 * skips.
 */
export class StatementSplitter {
  private pending = "";
  /** What the scan is inside: a quote character, `--`, `/*`, or nothing. */
  private inside: string | null = null;
  /** Where scanning resumes in `pending`. */
  private scanned = 0;

  /** The statements `chunk` completes. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const done: string[] = [];
    let start = 0;
    let at = this.scanned;
    for (; at < this.pending.length; at += 1) {
      const char = this.pending[at]!;
      const next = this.pending[at + 1];
      if (this.inside === "--") {
        if (char === "\n") this.inside = null;
      } else if (this.inside === "/*") {
        if (char === "*") {
          if (next === undefined) break;
          if (next === "/") {
            this.inside = null;
            at += 1;
          }
        }
      } else if (this.inside !== null) {
        if (char === this.inside) this.inside = null;
      } else if (char === "'" || char === '"' || char === "`") {
        this.inside = char;
      } else if (char === "-" || char === "/") {
        // A comment opener may be cut between two pieces: wait for the next.
        if (next === undefined) break;
        if (char === "-" && next === "-") this.inside = "--";
        else if (char === "/" && next === "*") this.inside = "/*";
        if (this.inside !== null) at += 1;
      } else if (char === ";") {
        done.push(this.pending.slice(start, at + 1));
        start = at + 1;
      }
    }
    this.pending = this.pending.slice(start);
    this.scanned = at - start;
    return done;
  }

  /** What is left once the text has ended: nothing but blanks and comments in a whole export. */
  rest(): string {
    return this.pending.replace(/--[^\n]*(\n|$)/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "").trim();
  }
}

/** How many statements are run at once while loading. */
const BATCH = 500;

/**
 * Loads an export's text into `db` as it arrives, in one transaction. Foreign
 * keys are not enforced: an export writes each table's rows right after the
 * table, so a row can come before the table it refers to.
 */
class ExportLoader {
  private readonly db: DatabaseSync;
  private readonly splitter = new StatementSplitter();
  private batch: string[] = [];

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("BEGIN");
  }

  push(chunk: string): void {
    for (const statement of this.splitter.push(chunk)) {
      this.batch.push(statement);
      if (this.batch.length >= BATCH) this.flush();
    }
  }

  finish(): void {
    this.flush();
    if (this.splitter.rest() !== "") throw new Error("the export ends inside a statement: it is cut short");
    this.db.exec("COMMIT");
  }

  private flush(): void {
    if (this.batch.length > 0) this.db.exec(this.batch.join("\n"));
    this.batch = [];
  }
}

/** A v1 export held as text, loaded into a fresh in-memory database (for tests and small exports). */
export function loadV1Export(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const loader = new ExportLoader(db);
  loader.push(sql);
  loader.finish();
  return db;
}

/**
 * A v1 export file, read a piece at a time into a database in a new private
 * temporary folder. `close` deletes the folder: the database holds the same
 * secrets as the export.
 */
export async function openV1Export(path: string): Promise<{ db: DatabaseSync; close: () => void }> {
  const folder = mkdtempSync(join(tmpdir(), "agw-v1-export-"));
  const db = new DatabaseSync(join(folder, "v1.sqlite"), { enableForeignKeyConstraints: false });
  const close = () => {
    if (db.isOpen) db.close();
    rmSync(folder, { recursive: true, force: true });
  };
  try {
    const loader = new ExportLoader(db);
    for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 })) loader.push(chunk as string);
    loader.finish();
    return { db, close };
  } catch (error) {
    close();
    throw error;
  }
}
