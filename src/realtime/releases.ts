import { GatewayError } from "../core/errors";
import { readOrKnown, STALE_READ_MAX_MS, type KnownRecord } from "../core/stale-read";
import { ttlCache } from "../core/ttl-cache";
import { REALTIME_BACKEND_CONTRACT } from "./relay/contract";

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

/**
 * The realtime Worker new sessions go to, or null when none has been promoted
 * yet: seamless releases were just turned on, or their first release failed.
 * The gateway then serves sessions itself rather than refuse them.
 */
export async function activeRealtimeRelease(db: D1Database): Promise<RealtimeRelease | null> {
  const row = await cachedRead("active", () => db.prepare(`SELECT r.id, r.url, r.backend_contract, r.retired_at FROM realtime_release r
    JOIN gateway_release_state s ON s.active_realtime_id = r.id WHERE s.singleton = 1`).first<RealtimeRelease>());
  if (!row) return null;
  if (row.backend_contract !== REALTIME_BACKEND_CONTRACT) {
    throw new GatewayError(503, "provider_unavailable", "Realtime release is not ready");
  }
  return row;
}

export async function requireRealtimeAdmission(db: D1Database, releaseId: string): Promise<void> {
  const row = await cachedRead(`admission:${releaseId}`, () => db
    .prepare("SELECT r.backend_contract, r.retired_at, s.active_realtime_id FROM realtime_release r "
      + "CROSS JOIN gateway_release_state s WHERE r.id = ? AND s.singleton = 1")
    .bind(releaseId)
    .first<AdmissionRow>());
  if (!row || row.backend_contract !== REALTIME_BACKEND_CONTRACT || closedToSessions(row, releaseId)) {
    throw new GatewayError(409, "conflict", "Realtime release retired; discover the current connection URL");
  }
}

/**
 * Release rows, read once every few seconds per isolate, as every new session
 * reads them: a promotion or retirement is seen within that, well inside the
 * 60-second admission grace. When D1 stalls or fails, the last answer is used
 * (see `../core/stale-read`), so a D1 blip does not refuse new sessions while
 * HTTP requests are still served. Keys are the active pointer and the ids of
 * this installation's own releases, so there are few of them.
 */
const RELEASE_READ_TTL_MS = 5_000;
const releaseReads = ttlCache<string, Promise<unknown>>({
  name: "realtime-release",
  ttlMs: RELEASE_READ_TTL_MS,
  maxEntries: 100,
});
const lastKnownRelease = ttlCache<string, unknown>({
  name: "realtime-release-last-known",
  ttlMs: STALE_READ_MAX_MS,
  maxEntries: 100,
});

function cachedRead<V>(key: string, read: () => Promise<V>): Promise<V> {
  const known = lastKnownRelease.peek(key) as KnownRecord<V> | undefined;
  const cached = releaseReads.get(key) as Promise<V> | undefined;
  if (cached !== undefined) {
    // A read that has answered is the answer. One still in flight is waited
    // for no longer than the caller that started it waits.
    if (known === undefined || known.storedAt >= releaseReads.peek(key)!.storedAt) return cached;
    return readOrKnown("realtime_release", known, () => cached);
  }
  return readOrKnown("realtime_release", known, () => {
    const startedAt = Date.now();
    // A failure thrown at once is a failed read like any other.
    const pending = Promise.resolve().then(read);
    releaseReads.set(key, pending, { storedAt: startedAt });
    void pending.then(
      (value) => {
        if (releaseReads.peek(key)?.value === pending) lastKnownRelease.set(key, value, { storedAt: startedAt });
      },
      () => {
        if (releaseReads.peek(key)?.value === pending) releaseReads.delete(key);
      },
    );
    return pending;
  });
}
