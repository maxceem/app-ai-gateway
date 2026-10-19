import { GatewayError } from "../core/errors";
import { REALTIME_BACKEND_CONTRACT } from "./backend";

export const REALTIME_ADMISSION_GRACE_MS = 60_000;

/**
 * Whether realtime sessions run in a Worker of their own for each release,
 * which a gateway deploy leaves running, so open conversations survive it.
 * Off by default: the gateway serves sessions itself, and a deploy ends the
 * ones open at that moment.
 */
export function seamlessReleases(env: { REALTIME_RELEASES?: string }): boolean {
  return env.REALTIME_RELEASES === "seamless";
}

export interface RealtimeRelease {
  id: string;
  url: string;
  backend_contract: number;
  retired_at: number | null;
}

type AdmissionRow = Pick<RealtimeRelease, "backend_contract" | "retired_at"> & {
  active_realtime_id: string | null;
};

/**
 * Whether a release no longer admits new sessions: one still serving is
 * superseded once another is active, and a retired one once its grace ends.
 */
function closedToSessions(row: AdmissionRow, releaseId: string): boolean {
  if (row.retired_at === null) return row.active_realtime_id !== releaseId;
  return Date.now() >= row.retired_at + REALTIME_ADMISSION_GRACE_MS;
}

export async function activeRealtimeRelease(db: D1Database): Promise<RealtimeRelease> {
  const row = await db.prepare(`SELECT r.id, r.url, r.backend_contract, r.retired_at FROM realtime_release r
    JOIN gateway_release_state s ON s.active_realtime_id = r.id WHERE s.singleton = 1`).first<RealtimeRelease>();
  if (!row || row.backend_contract !== REALTIME_BACKEND_CONTRACT) {
    throw new GatewayError(503, "provider_unavailable", "Realtime release is not ready");
  }
  return row;
}

export async function requireRealtimeAdmission(db: D1Database, releaseId: string): Promise<void> {
  const row = await db
    .prepare("SELECT r.backend_contract, r.retired_at, s.active_realtime_id FROM realtime_release r "
      + "CROSS JOIN gateway_release_state s WHERE r.id = ? AND s.singleton = 1")
    .bind(releaseId)
    .first<AdmissionRow>();
  if (!row || row.backend_contract !== REALTIME_BACKEND_CONTRACT || closedToSessions(row, releaseId)) {
    throw new GatewayError(409, "conflict", "Realtime release retired; discover the current connection URL");
  }
}
