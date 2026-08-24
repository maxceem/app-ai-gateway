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

/** Atomically inserts one app only while the organization remains below its plan limit. */
export async function insertAppWithinCapacity(
  d1: D1Database,
  values: AtomicAppWrite,
  maxApps: number | undefined,
): Promise<boolean> {
  const result = await d1.prepare(
    `INSERT INTO apps(id, organization_id, name, config_json, status, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE ? IS NULL
         OR (SELECT COUNT(*) FROM apps WHERE organization_id = ?) < ?
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
  ).bind(
    ...bindings(values),
    maxApps ?? null,
    values.organizationId,
    maxApps ?? null,
  ).all<{ id: string }>();
  return result.results.length === 1;
}

/**
 * Atomically creates or updates an app. Conflict updates are allowed only when
 * the stored row belongs to the same organization; creation is conditional on
 * the plan capacity at statement execution time.
 */
export async function upsertAppWithinCapacity(
  d1: D1Database,
  values: AtomicAppWrite,
  maxApps: number | undefined,
): Promise<boolean> {
  const result = await d1.prepare(
    `INSERT INTO apps(id, organization_id, name, config_json, status, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
              SELECT 1 FROM apps
               WHERE id = ? AND organization_id = ?
            )
         OR ? IS NULL
         OR (SELECT COUNT(*) FROM apps WHERE organization_id = ?) < ?
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       config_json = excluded.config_json,
       status = excluded.status,
       updated_at = excluded.updated_at
     WHERE apps.organization_id = excluded.organization_id
     RETURNING id`,
  ).bind(
    ...bindings(values),
    values.id,
    values.organizationId,
    maxApps ?? null,
    values.organizationId,
    maxApps ?? null,
  ).all<{ id: string }>();
  return result.results.length === 1;
}
