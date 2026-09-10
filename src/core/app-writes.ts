import type { app } from "../db/schema";
import type { StoredAppConfig } from "./types";

export interface AtomicAppWrite {
  id: string;
  organizationId: string;
  name: string;
  config: StoredAppConfig;
  status: "active" | "disabled";
  updatedAt?: string;
}

/** The stored app, as the writing statement itself returned it. */
export type StoredAppRow = typeof app.$inferSelect;

const RETURNED_COLUMNS = "id, organization_id, name, config_json, status, created_at, updated_at";

interface ReturnedRow {
  id: string;
  organization_id: string;
  name: string;
  config_json: string;
  status: string;
  created_at: string;
  updated_at: string;
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
    config: JSON.parse(row.config_json) as StoredAppConfig,
    status: row.status as StoredAppRow["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  const result = await d1.prepare(
    `INSERT INTO app(id, organization_id, name, config_json, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING ${RETURNED_COLUMNS}`,
  ).bind(
    values.id,
    values.organizationId,
    values.name,
    JSON.stringify(values.config),
    values.status,
    values.updatedAt ?? new Date().toISOString(),
  ).all<ReturnedRow>();
  const row = result.results[0];
  return row ? hydrate(row) : null;
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
  values: AtomicAppWrite,
): Promise<StoredAppRow | null> {
  const result = await d1.prepare(
    `UPDATE app SET
       name = ?,
       config_json = ?,
       status = ?,
       updated_at = ?
     WHERE id = ? AND organization_id = ?
     RETURNING ${RETURNED_COLUMNS}`,
  ).bind(
    values.name,
    JSON.stringify(values.config),
    values.status,
    values.updatedAt ?? new Date().toISOString(),
    values.id,
    values.organizationId,
  ).all<ReturnedRow>();
  const row = result.results[0];
  return row ? hydrate(row) : null;
}
