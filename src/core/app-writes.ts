import type { StoredAppConfig } from "./types";

export interface AtomicAppWrite {
  id: string;
  organizationId: string;
  name: string;
  config: StoredAppConfig;
  status: "active" | "disabled";
  updatedAt?: string;
}

function bindings(values: AtomicAppWrite) {
  return [
    values.id,
    values.organizationId,
    values.name,
    JSON.stringify(values.config),
    values.status,
    values.updatedAt ?? new Date().toISOString(),
  ] as const;
}

/** Inserts one app, or reports that the id was already taken. */
export async function insertApp(
  d1: D1Database,
  values: AtomicAppWrite,
): Promise<boolean> {
  const result = await d1.prepare(
    `INSERT INTO app(id, organization_id, name, config_json, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
  ).bind(...bindings(values)).all<{ id: string }>();
  return result.results.length === 1;
}

/**
 * Atomically creates or updates an app. Conflict updates are allowed only while
 * the stored row belongs to the same organization, so an id taken by another
 * tenant is never silently overwritten.
 */
export async function upsertApp(
  d1: D1Database,
  values: AtomicAppWrite,
): Promise<boolean> {
  const result = await d1.prepare(
    `INSERT INTO app(id, organization_id, name, config_json, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       status = excluded.status,
       updated_at = excluded.updated_at
     WHERE app.organization_id = excluded.organization_id
     RETURNING id`,
  ).bind(...bindings(values)).all<{ id: string }>();
  return result.results.length === 1;
}
