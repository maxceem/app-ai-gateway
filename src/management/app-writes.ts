import { sql, type SQL } from "drizzle-orm";
import type { app } from "../db/schema";
import { prepared } from "../db/sql";
import type { AppConfig } from "../shared/app-config";

export interface AtomicAppWrite {
  id: string;
  organizationId: string;
  name: string;
  config: AppConfig;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
  expectedRevision?: number;
}

/** The stored app, as the writing statement itself returned it. */
export type StoredAppRow = typeof app.$inferSelect;

const RETURNED_COLUMNS = sql.raw(
  "id, organization_id, name, config_json, auth_type, status, created_at, updated_at, revision",
);

interface ReturnedRow {
  id: string;
  organization_id: string;
  name: string;
  config_json: string;
  auth_type: string;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

/**
 * The row as the rest of the Worker reads apps: camelCase, with the stored
 * configuration parsed. `config_json` is written by these statements alone, so
 * it is always the JSON they serialized.
 */
function hydrate(row: ReturnedRow): StoredAppRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    config: JSON.parse(row.config_json) as AppConfig,
    authType: row.auth_type,
    status: row.status as StoredAppRow["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

/**
 * Inserts one app and answers with the stored row, or with null when the id was
 * already taken. Returning the row is what lets a caller answer with the values
 * the database settled on — `created_at` and `updated_at` among them — without
 * a second read that another write could slip in front of.
 */
export async function insertApp(
  d1: D1Database,
  values: AtomicAppWrite,
): Promise<StoredAppRow | null> {
  const result = await prepared(d1, appInsert(values, sql`1`, { ignoreCollision: true }))
    .all<ReturnedRow>();
  const row = result.results[0];
  return row ? hydrate(row) : null;
}

/**
 * The app insert shared by ordinary writes and by CLI operations: the row
 * lands only where `guard` holds, and the statement returns what it stored.
 */
export function appInsert(
  values: AtomicAppWrite,
  guard: SQL,
  options: { ignoreCollision?: boolean } = {},
): SQL {
  const now = new Date().toISOString();
  return sql`INSERT INTO app(id,organization_id,name,config_json,auth_type,status,created_at,updated_at,revision)
     SELECT ${values.id},${values.organizationId},${values.name},${JSON.stringify(values.config)},
       ${values.config.authentication.type},${values.status},
       ${values.createdAt ?? now},${values.updatedAt ?? now},1
     WHERE ${guard}
     ${options.ignoreCollision ? sql`ON CONFLICT(id) DO NOTHING` : sql.empty()}
     RETURNING ${RETURNED_COLUMNS}`;
}

/**
 * Updates one app in place and answers with the stored row, and only while that
 * row still belongs to the given organization — the id alone never authorizes a
 * write, so a row deleted or held by another tenant is reported as null rather
 * than clobbered or recreated. Apps are only ever created by {@link insertApp},
 * under an id the gateway assigns.
 */
export async function updateApp(
  d1: D1Database,
  values: AtomicAppWrite & { expectedRevision: number },
): Promise<StoredAppRow | null> {
  const result = await prepared(d1, sql`UPDATE app SET
       name = ${values.name},
       config_json = ${JSON.stringify(values.config)},
       auth_type = ${values.config.authentication.type},
       status = ${values.status},
       updated_at = ${values.updatedAt ?? new Date().toISOString()},
       revision = revision + 1
     WHERE id = ${values.id} AND organization_id = ${values.organizationId}
       AND revision = ${values.expectedRevision}
     RETURNING ${RETURNED_COLUMNS}`).all<ReturnedRow>();
  const row = result.results[0];
  return row ? hydrate(row) : null;
}
