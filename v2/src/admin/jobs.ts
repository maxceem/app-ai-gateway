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
  /** What the job's corrections add up to, and how many there are. */
  correction_nano: number | null;
  corrections: number;
  /** When its settlement correction was written, and how that figure was measured. */
  settled_at: number | null;
  settled_measured: string | null;
  /** The sweep's work for it: still to do, run out of tries, and the next due time. */
  open_work: number;
  gave_up_work: number;
  next_due_at: number | null;
}

/** How long a job stays in the list: a day inside the 90 days its charges are kept. */
export const JOB_LIST_DAYS = 89;
const DAY_MS = 86_400_000;

type JobState = OperationResponse<"listAppJobs">["jobs"][number]["state"];

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Where a job stands: settled once its settlement correction exists; checking
 * while the sweep still holds live work for it; given up when its only work
 * ran out of tries; otherwise the estimate stays.
 */
function jobState(settled: boolean, work: Pick<EstimateRow, "open_work" | "gave_up_work">): JobState {
  if (settled) return "settled";
  if (work.open_work > 0) return "checking";
  if (work.gave_up_work > 0) return "gave_up";
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

  // Only jobs inside the window their charges are surely kept in: retention
  // deletes a job's corrections and then its estimate, in separate chunks, from
  // 90 days on, so an older job could show as unsettled with its estimate as
  // its total.
  const since = Date.now() - JOB_LIST_DAYS * DAY_MS;
  // `settled`: whether the job's settlement correction exists, by its key.
  const settledFilter = query.settled === undefined
    ? ""
    : ` AND ${query.settled === "true" ? "" : "NOT "}EXISTS (SELECT 1 FROM charge AS settlement WHERE settlement.id = 'settle:job:' || charge.owner_id)`;
  const jobs = `FROM charge
        WHERE account_id = ?1 AND app_id = ?2 AND owner_type = 'job' AND kind = 'estimate' AND used_at >= ?3${settledFilter}`;
  // One batch, so one snapshot: the filter and each job's corrections and work
  // are read together, and a settlement written meanwhile shows in both or neither.
  const [total, page] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS value ${jobs}`).bind(actor.accountId, appId, since),
    c.env.DB.prepare(
      `SELECT owner_id, provider_connection_id, operation, model, end_user_id, used_at, cost_nano, measured, price_source,
              (SELECT SUM(fix.cost_nano) FROM charge AS fix
                WHERE fix.owner_type = 'job' AND fix.owner_id = charge.owner_id AND fix.kind = 'correction'
                  AND fix.account_id = ?1 AND fix.app_id = ?2) AS correction_nano,
              (SELECT COUNT(*) FROM charge AS fix
                WHERE fix.owner_type = 'job' AND fix.owner_id = charge.owner_id AND fix.kind = 'correction'
                  AND fix.account_id = ?1 AND fix.app_id = ?2) AS corrections,
              (SELECT written_at FROM charge AS settlement
                WHERE settlement.id = 'settle:job:' || charge.owner_id AND settlement.account_id = ?1) AS settled_at,
              (SELECT measured FROM charge AS settlement
                WHERE settlement.id = 'settle:job:' || charge.owner_id AND settlement.account_id = ?1) AS settled_measured,
              (SELECT COUNT(*) FROM open_work AS work
                WHERE work.owner_type = 'job' AND work.owner_id = charge.owner_id AND work.account_id = ?1
                  AND work.gave_up_at IS NULL) AS open_work,
              (SELECT COUNT(*) FROM open_work AS work
                WHERE work.owner_type = 'job' AND work.owner_id = charge.owner_id AND work.account_id = ?1
                  AND work.gave_up_at IS NOT NULL) AS gave_up_work,
              (SELECT MIN(due_at) FROM open_work AS work
                WHERE work.owner_type = 'job' AND work.owner_id = charge.owner_id AND work.account_id = ?1
                  AND work.gave_up_at IS NULL) AS next_due_at
         ${jobs}
        ORDER BY used_at DESC, owner_id
        LIMIT ?4 OFFSET ?5`,
    ).bind(actor.accountId, appId, since, query.limit, query.offset),
  ]);
  const estimates = (page?.results ?? []) as EstimateRow[];
  const connections = JSON.stringify([...new Set(estimates.map((row) => row.provider_connection_id).filter((id) => id !== null))]);
  const slugs = estimates.length === 0
    ? null
    : await c.env.DB.prepare("SELECT id, slug FROM provider_connection WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))")
        .bind(actor.accountId, connections)
        .all<{ id: string; slug: string }>();
  const slugBy = new Map((slugs?.results ?? []).map((row) => [row.id, row.slug]));

  return c.json({
    app_id: appId,
    total: ((total?.results[0] as { value?: number } | undefined)?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    jobs: estimates.map((row) => {
      const settledAt = row.settled_at;
      const correctionNano = row.corrections === 0 ? null : row.correction_nano;
      const totalNano = row.cost_nano === null && correctionNano === null ? null : (row.cost_nano ?? 0) + (correctionNano ?? 0);
      const state = jobState(settledAt !== null, row);
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
        // Once settled, the label is the settlement's, not the estimate's.
        measured: settledAt !== null ? (row.settled_measured ?? row.measured) : row.measured,
        price_source: row.price_source,
        state,
        settled_at: iso(settledAt),
        ...(state === "checking" ? { next_check_at: iso(row.next_due_at) } : {}),
      };
    }),
  } satisfies OperationResponse<"listAppJobs">);
}
