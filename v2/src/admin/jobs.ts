/**
 * An app's jobs, through the management API (plan D9): each job's estimate,
 * what the provider's final figure corrected it by, and where it stands.
 *
 * Read from the ledger and the open work alone: a job is its estimate charge
 * (`kind = 'estimate'`, `owner_type = 'job'`), its corrections, and the
 * open-work rows the sweep still holds for it.
 */
import type { Context } from "hono";
import { JobListQuerySchema } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import type { AdminVariables } from "./actor.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

interface EstimateRow {
  owner_id: string;
  provider_connection_id: string | null;
  operation: string;
  model: string | null;
  end_user_id: string | null;
  used_at: number;
  cost_nano: number | null;
  measured: string;
  price_source: string;
}

interface CorrectionRow {
  owner_id: string;
  cost_nano: number | null;
  settled_at: number | null;
}

interface WorkRow {
  owner_id: string;
  open: number;
  gave_up: number;
}

type JobState = OperationResponse<"listAppJobs">["jobs"][number]["state"];

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Where a job stands: settled once its settlement correction exists; checking
 * while the sweep still holds live work for it; given up when its only work
 * ran out of tries; otherwise the estimate stays.
 */
function jobState(settled: boolean, work: WorkRow | undefined): JobState {
  if (settled) return "settled";
  if (work !== undefined && work.open > 0) return "checking";
  if (work !== undefined && work.gave_up > 0) return "gave_up";
  return "estimate_kept";
}

// Every query is bound to the caller's account as well as the app: an app id
// may be reused after another account deleted its app, and the ledger keeps
// that account's rows.
export async function listAppJobs(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const parsed = JobListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new GatewayError(400, "invalid_request", parsed.error.issues[0]?.message ?? "The query is invalid");
  const query = parsed.data;
  const app = await c.env.DB.prepare("SELECT 1 AS found FROM app WHERE id = ? AND account_id = ?").bind(appId, actor.accountId).first();
  if (app === null) throw new GatewayError(404, "app_not_found", "App is not registered");

  const [total, page] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS value FROM charge WHERE account_id = ? AND app_id = ? AND owner_type = 'job' AND kind = 'estimate'",
    ).bind(actor.accountId, appId),
    c.env.DB.prepare(
      `SELECT owner_id, provider_connection_id, operation, model, end_user_id, used_at, cost_nano, measured, price_source
         FROM charge
        WHERE account_id = ? AND app_id = ? AND owner_type = 'job' AND kind = 'estimate'
        ORDER BY used_at DESC, owner_id
        LIMIT ? OFFSET ?`,
    ).bind(actor.accountId, appId, query.limit, query.offset),
  ]);
  const estimates = (page?.results ?? []) as EstimateRow[];
  const ids = JSON.stringify(estimates.map((row) => row.owner_id));
  const connections = JSON.stringify([...new Set(estimates.map((row) => row.provider_connection_id).filter((id) => id !== null))]);

  const [corrections, work, slugs] = estimates.length === 0
    ? [null, null, null]
    : await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT owner_id, SUM(cost_nano) AS cost_nano,
                  MAX(CASE WHEN id = 'settle:job:' || owner_id THEN written_at END) AS settled_at
             FROM charge
            WHERE account_id = ? AND app_id = ? AND owner_type = 'job' AND kind = 'correction' AND owner_id IN (SELECT value FROM json_each(?))
            GROUP BY owner_id`,
        ).bind(actor.accountId, appId, ids),
        c.env.DB.prepare(
          `SELECT owner_id, SUM(gave_up_at IS NULL) AS open, SUM(gave_up_at IS NOT NULL) AS gave_up
             FROM open_work
            WHERE account_id = ? AND app_id = ? AND owner_type = 'job' AND owner_id IN (SELECT value FROM json_each(?))
            GROUP BY owner_id`,
        ).bind(actor.accountId, appId, ids),
        c.env.DB.prepare("SELECT id, slug FROM provider_connection WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))").bind(
          actor.accountId,
          connections,
        ),
      ]);
  const correctionBy = new Map(((corrections?.results ?? []) as CorrectionRow[]).map((row) => [row.owner_id, row]));
  const workBy = new Map(((work?.results ?? []) as WorkRow[]).map((row) => [row.owner_id, row]));
  const slugBy = new Map(((slugs?.results ?? []) as { id: string; slug: string }[]).map((row) => [row.id, row.slug]));

  return c.json({
    app_id: appId,
    total: ((total?.results[0] as { value?: number } | undefined)?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    jobs: estimates.map((row) => {
      const correction = correctionBy.get(row.owner_id);
      const settledAt = correction?.settled_at ?? null;
      const correctionNano = correction === undefined ? null : correction.cost_nano;
      const totalNano = row.cost_nano === null && correctionNano === null ? null : (row.cost_nano ?? 0) + (correctionNano ?? 0);
      return {
        id: row.owner_id,
        provider_slug: row.provider_connection_id === null ? null : (slugBy.get(row.provider_connection_id) ?? null),
        operation: row.operation,
        model: row.model,
        end_user_id: row.end_user_id,
        submitted_at: new Date(row.used_at).toISOString(),
        estimate_nano: row.cost_nano,
        correction_nano: correctionNano,
        total_nano: totalNano,
        measured: row.measured,
        price_source: row.price_source,
        state: jobState(settledAt !== null, workBy.get(row.owner_id)),
        settled_at: iso(settledAt),
      };
    }),
  } satisfies OperationResponse<"listAppJobs">);
}
