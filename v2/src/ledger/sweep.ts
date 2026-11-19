/**
 * The sweep: open work, done in small batches every minute (plan section 4.2,
 * "Open work and the sweep"; rule S17).
 *
 * - Earliest due first, at most `SWEEP_BATCH` rows a run.
 * - Each item has `SWEEP_ITEM_TIME_LIMIT_MS`; a run stops starting new items
 *   after `SWEEP_RUN_TIME_LIMIT_MS`. The rest waits for the next run.
 * - Work that fails, times out or is not ready gets a later due time and one
 *   more try, so it cannot keep taking the batch.
 * - After `SWEEP_MAX_TRIES`, the row is marked given up and stays, and an
 *   error is logged, so the monitor alerts and the console can show it.
 * - Every handler is safe to run twice: settlement and pricing write one
 *   correction per owner, so a crash between doing the work and deleting the
 *   row only repeats a no-op.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { priceUnresolvedCharge } from "./corrections.ts";
import type { OpenWorkKind } from "./labels.ts";
import { settleSession } from "./sessions.ts";

/** The sweep's cron: every minute, faster than fal's shortest result window. Also in wrangler.jsonc. */
export const SWEEP_CRON = "* * * * *";

/** Rows taken per run. Small, so one run stays well inside a cron invocation. */
export const SWEEP_BATCH = 25;
/** The longest one item may take before it counts as failed for this run. */
export const SWEEP_ITEM_TIME_LIMIT_MS = 5_000;
/** A run starts no new item after this long, so the next minute's run is never crowded. */
export const SWEEP_RUN_TIME_LIMIT_MS = 30_000;
/** The first retry delay, doubling with each try up to `SWEEP_MAX_RETRY_DELAY_MS`. */
export const SWEEP_FIRST_RETRY_MS = 60_000;
/** The longest wait between tries: work never waits more than six hours between two of them. */
export const SWEEP_MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
/** Tries before the sweep gives up: about three days with the delays above. */
export const SWEEP_MAX_TRIES = 20;

/** One open-work row as the sweep reads it. */
export interface OpenWorkItem {
  readonly id: string;
  readonly kind: OpenWorkKind;
  readonly accountId: string;
  readonly appId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly chargeId: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly dueAt: number;
  readonly tries: number;
}

/** What a handler did: finished (the row is removed), or try again later with a reason. */
export type HandlerResult = { readonly done: true } | { readonly done: false; readonly reason: string };

export type OpenWorkHandler = (
  env: Env,
  item: OpenWorkItem,
  context: { readonly now: number; readonly lastTry: boolean },
) => Promise<HandlerResult>;

const DONE: HandlerResult = { done: true };
const retry = (reason: string): HandlerResult => ({ done: false, reason });

/**
 * Provider-specific work, by provider type: cost lookups (Deepgram's request
 * record, ElevenLabs' conversation record) and job checks (fal). Each
 * provider's step adds its entry. Work for a provider with no entry waits.
 */
export const PROVIDER_LOOKUPS: Record<string, OpenWorkHandler> = {};
export const JOB_CHECKS: Record<string, OpenWorkHandler> = {};

function byProvider(table: Record<string, OpenWorkHandler>, what: string): OpenWorkHandler {
  return async (env, item, context) => {
    const provider = item.detail?.providerType;
    const handler = typeof provider === "string" && Object.hasOwn(table, provider) ? table[provider] : undefined;
    if (handler === undefined) return retry(`no ${what} for provider ${String(provider)}`);
    return handler(env, item, context);
  };
}

/** The handler for each kind of open work. */
export const OPEN_WORK_HANDLERS: Record<OpenWorkKind, OpenWorkHandler> = {
  async unresolved(env, item, { now }) {
    if (item.chargeId === null) return DONE;
    const result = await priceUnresolvedCharge(env.DB, { chargeId: item.chargeId, now });
    switch (result.status) {
      case "priced":
      case "already":
        return DONE;
      case "charge_missing":
        // Still in the failed-write store, most likely.
        return retry("charge not in the ledger yet");
      case "no_price":
        return retry("no price yet");
    }
  },
  async stale_session(env, item, { now, lastTry }) {
    const result = await settleSession(env.DB, { sessionId: item.ownerId, now, lastTry });
    return result === "waiting" || result === "not_closed" ? retry(`session ${result}`) : DONE;
  },
  provider_lookup: byProvider(PROVIDER_LOOKUPS, "cost lookup"),
  job_check: byProvider(JOB_CHECKS, "job check"),
};

export interface SweepSummary {
  readonly done: number;
  readonly retried: number;
  readonly gaveUp: number;
}

function itemFromRow(row: Record<string, unknown>): OpenWorkItem {
  return {
    id: String(row.id),
    kind: row.kind as OpenWorkKind,
    accountId: String(row.account_id),
    appId: String(row.app_id),
    ownerType: String(row.owner_type),
    ownerId: String(row.owner_id),
    chargeId: row.charge_id === null ? null : String(row.charge_id),
    detail: typeof row.detail_json === "string" ? (JSON.parse(row.detail_json) as Record<string, unknown>) : null,
    dueAt: Number(row.due_at),
    tries: Number(row.tries),
  };
}

/** The delay before try number `tries + 1`. */
export function retryDelay(tries: number): number {
  return Math.min(SWEEP_MAX_RETRY_DELAY_MS, SWEEP_FIRST_RETRY_MS * 2 ** Math.max(0, tries - 1));
}

const TIMED_OUT = Symbol("timed out");

/** Runs one sweep: the due rows, earliest first, each with its time limit. */
export async function runSweep(
  env: Env,
  options: {
    readonly now?: number;
    readonly handlers?: Record<OpenWorkKind, OpenWorkHandler>;
    readonly batch?: number;
    readonly itemTimeLimitMs?: number;
    readonly runTimeLimitMs?: number;
  } = {},
): Promise<SweepSummary> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const handlers = options.handlers ?? OPEN_WORK_HANDLERS;
  const itemLimit = options.itemTimeLimitMs ?? SWEEP_ITEM_TIME_LIMIT_MS;
  const runLimit = options.runTimeLimitMs ?? SWEEP_RUN_TIME_LIMIT_MS;
  const rows = await env.DB.prepare(
    "SELECT * FROM open_work WHERE gave_up_at IS NULL AND due_at <= ? ORDER BY due_at, id LIMIT ?",
  )
    .bind(now, options.batch ?? SWEEP_BATCH)
    .all<Record<string, unknown>>();

  let done = 0;
  let retried = 0;
  let gaveUp = 0;
  for (const row of rows.results) {
    if (Date.now() - startedAt >= runLimit) break;
    const item = itemFromRow(row);
    const lastTry = item.tries + 1 >= SWEEP_MAX_TRIES;
    let result: HandlerResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), itemLimit);
      });
      const answer = await Promise.race([handlers[item.kind](env, item, { now, lastTry }), late]);
      result = answer === TIMED_OUT ? retry("timed out") : answer;
    } catch (error) {
      log("warn", "open_work_failed", { app: item.appId, work: item.id, kind: item.kind, error: errorFacts(error) });
      result = retry("failed");
    } finally {
      clearTimeout(timer);
    }

    try {
      if (result.done) {
        await env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(item.id).run();
        done += 1;
      } else if (lastTry) {
        await env.DB.prepare("UPDATE open_work SET tries = tries + 1, last_error = ?, gave_up_at = ? WHERE id = ?")
          .bind(result.reason, now, item.id)
          .run();
        log("error", "open_work_gave_up", { app: item.appId, work: item.id, kind: item.kind, tries: item.tries + 1, reason: result.reason });
        gaveUp += 1;
      } else {
        await env.DB.prepare("UPDATE open_work SET tries = tries + 1, last_error = ?, due_at = ? WHERE id = ?")
          .bind(result.reason, now + retryDelay(item.tries + 1), item.id)
          .run();
        retried += 1;
      }
    } catch (error) {
      // The row stays as it was; the next run takes it again. Every handler is safe to repeat.
      log("warn", "open_work_unrecorded", { app: item.appId, work: item.id, error: errorFacts(error) });
    }
  }
  if (rows.results.length > 0) log("info", "sweep_ran", { done, retried, gaveUp, taken: rows.results.length });
  return { done, retried, gaveUp };
}

