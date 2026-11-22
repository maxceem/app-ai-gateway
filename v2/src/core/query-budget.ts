/**
 * A run's allowance of calls (v1's `src/core/query-budget.ts`): the nightly
 * maintenance's D1 statements, and conversation retention's R2 calls and D1
 * queries.
 */
import { log } from "./log.ts";

/**
 * Thrown instead of issuing a statement a budget cannot pay for.
 *
 * Refusing is the whole point: exceeding D1's per-invocation subrequest ceiling
 * throws anyway, but from inside the platform and at whatever statement happens
 * to be next, which takes the rest of the run down with it. Refusing here stops
 * the one loop that ran long and leaves the run's own error handling to decide
 * what that means.
 */
export class QueryBudgetExhausted extends Error {
  constructor(readonly limit: number) {
    super(`Query budget of ${limit} statements is exhausted`);
    this.name = "QueryBudgetExhausted";
  }
}

/**
 * The real statement behind a wrapper, so `batch` can hand D1 its own objects.
 *
 * A wrapper is a Proxy over the statement it stands for, and D1 rejects a Proxy
 * where it expects one of its own; keyed weakly so a wrapper the caller drops is
 * not kept alive by this map.
 */
const WRAPPED_STATEMENTS = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

/**
 * The real database behind a wrapper, so wrapping a database already seen
 * through a budget never charges twice.
 */
const WRAPPED_DATABASES = new WeakMap<D1Database, D1Database>();

/**
 * A scheduled run's query allowance, counting the statements actually issued.
 *
 * Mutable and shared rather than returned, so that a sweep which throws partway
 * still leaves an accurate count behind for the sweep after it.
 *
 * Nothing declares its own cost to this: a sweep is given
 * {@link QueryBudget.database} and is charged for what it issues, so a sweep
 * cannot drift from a constant that promised what it would spend. A loop that
 * must finish a step it starts asks {@link QueryBudget.affords} first; anything
 * else simply runs until a statement is refused.
 */
export class QueryBudget {
  #spent = 0;

  constructor(readonly limit: number) {
    this.limit = Math.max(0, limit);
  }

  /** Statements issued through this budget so far. */
  get spent(): number {
    return this.#spent;
  }

  /** Statements this budget can still pay for. */
  get remaining(): number {
    return Math.max(0, this.limit - this.#spent);
  }

  /** Whether `n` more statements fit. Loops ask this before starting a step they must finish. */
  affords(n: number): boolean {
    return this.remaining >= n;
  }

  /** Charges `n`; throws {@link QueryBudgetExhausted} rather than exceeding the limit. */
  charge(n: number): void {
    if (this.#spent + n > this.limit) throw new QueryBudgetExhausted(this.limit);
    this.#spent += n;
  }

  /**
   * D1 as seen through this budget: every statement charges before it is issued.
   *
   * Statements are counted rather than calls, so a `batch` of seventeen costs
   * seventeen, where D1 counts it as one query against its per-invocation
   * limit. So the count is on the safe side.
   */
  database(db: D1Database): D1Database {
    const real = WRAPPED_DATABASES.get(db) ?? db;
    const wrapper = this.#wrap(real);
    WRAPPED_DATABASES.set(wrapper, real);
    return wrapper;
  }

  /** The shared `prepare`/`batch`/`exec`/`withSession` interception. */
  #wrap<T extends object>(target: T): T {
    const budget = this;
    return new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        const method = value.bind(inner) as (...args: unknown[]) => unknown;
        if (property === "prepare") {
          return (query: string) => budget.#statement(method(query) as D1PreparedStatement);
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            budget.charge(statements.length);
            return method(
              statements.map((statement) => WRAPPED_STATEMENTS.get(statement) ?? statement),
            );
          };
        }
        if (property === "exec") {
          return async (query: string) => {
            budget.charge(1);
            return method(query);
          };
        }
        if (property === "withSession") {
          return (constraintOrBookmark?: string) =>
            budget.#wrap(method(constraintOrBookmark) as object);
        }
        return method;
      },
    });
  }

  /** A statement that charges one on execution, and whose `bind` stays wrapped. */
  #statement(statement: D1PreparedStatement): D1PreparedStatement {
    const budget = this;
    const wrapper = new Proxy(statement, {
      get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        const method = value.bind(inner) as (...args: unknown[]) => unknown;
        if (property === "bind") {
          return (...values: unknown[]) =>
            budget.#statement(method(...values) as D1PreparedStatement);
        }
        if (property === "run" || property === "all" || property === "first" || property === "raw") {
          return async (...args: unknown[]) => {
            budget.charge(1);
            return method(...args);
          };
        }
        return method;
      },
    });
    WRAPPED_STATEMENTS.set(wrapper, statement);
    return wrapper;
  }
}

/**
 * Statements one nightly maintenance run may issue, across every pass.
 *
 * D1 queries are subrequests, and a Worker invocation may issue 1,000 of them
 * on the Workers Paid plan but only **50** on the Free plan. This project is
 * meant to be easy to self-host, so the default is the Free one: exceeding it
 * would not corrupt anything — every chunk a pass commits is its own
 * transaction — but D1 would refuse every query after it, every night.
 *
 * Statements are counted, not D1 queries: a batch of three statements counts
 * three here, where D1 counts it as one query. So the count is on the safe
 * side.
 */
export const DEFAULT_MAINTENANCE_STATEMENTS = 50;

/** Left unspent, so a miscount in one pass cannot reach the platform ceiling. */
export const MAINTENANCE_SLACK_STATEMENTS = 1;

/**
 * The fewest statements a run accepts: enough for the hourly clean-up beside
 * it and one round in which every pass gets a chunk. A test checks it against
 * the passes.
 */
export const MINIMUM_MAINTENANCE_STATEMENTS = 20;

/**
 * The most D1 queries one Worker invocation may make, on the Workers Paid
 * plan. A setting above it is lowered to it: a run that spent more would have
 * D1 refuse every query after the 1,000th, and the passes still to run would
 * fail every night.
 */
export const MAXIMUM_MAINTENANCE_STATEMENTS = 1_000;

/**
 * Rows one nightly run may write (D1 counts a deleted row and each of its
 * index entries as written). The Workers Free plan allows 100,000 row writes
 * a day for the whole account, and once they are spent D1 refuses queries
 * until midnight UTC, the apps' own requests included. So the run keeps to a
 * fifth of that by default, and leaves the rest for the apps.
 */
export const DEFAULT_MAINTENANCE_ROWS = 20_000;

/** The fewest rows a run accepts: enough for every pass to delete a few rows. */
export const MINIMUM_MAINTENANCE_ROWS = 1_000;

/**
 * The most rows a run accepts. Paid plans have no daily limit, only a price
 * per million rows written; this keeps a mistyped setting from paying for
 * more than about a thousand chunks in one night.
 */
export const MAXIMUM_MAINTENANCE_ROWS = 5_000_000;

/**
 * An optional whole-number setting between `minimum` and `maximum`: a value
 * below the minimum, or not a whole number, gives the default; one above the
 * maximum is lowered to it. Both are logged as `warn`.
 */
function setting(
  configured: string | undefined,
  name: string,
  { fallback, minimum, maximum }: { fallback: number; minimum: number; maximum: number },
): number {
  if (configured === undefined || configured.trim() === "") return fallback;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    // The value itself is not logged: a setting is text, and one pasted into
    // the wrong variable may be a secret.
    log("warn", `${name}_invalid`, { minimum, using: fallback });
    return fallback;
  }
  if (parsed > maximum) {
    log("warn", `${name}_capped`, { maximum });
    return maximum;
  }
  return parsed;
}

/**
 * The statement allowance for one nightly run, raised by
 * `MAINTENANCE_QUERY_BUDGET` (the name v1 used).
 *
 * Deliberately not a `vars` entry in `wrangler.jsonc`: the Deploy to Cloudflare
 * form shows every one of those as a field, and a deployment that never outgrows
 * the Free plan — which is most of them — should not have to answer a question
 * about D1 limits to install this gateway. A deployment on the Workers Paid
 * plan sets it in the dashboard or in a profile overlay once it has a
 * retention backlog worth clearing faster.
 */
export function maintenanceStatementBudget(env: Env): QueryBudget {
  const configured = (env as { MAINTENANCE_QUERY_BUDGET?: string }).MAINTENANCE_QUERY_BUDGET;
  const allowance = setting(configured, "maintenance_query_budget", {
    fallback: DEFAULT_MAINTENANCE_STATEMENTS,
    minimum: MINIMUM_MAINTENANCE_STATEMENTS,
    maximum: MAXIMUM_MAINTENANCE_STATEMENTS,
  });
  return new QueryBudget(allowance - MAINTENANCE_SLACK_STATEMENTS);
}

/** The rows one nightly run may write, raised by `MAINTENANCE_ROW_BUDGET`. Not a `vars` entry, for the same reason. */
export function maintenanceRowLimit(env: Env): number {
  const configured = (env as { MAINTENANCE_ROW_BUDGET?: string }).MAINTENANCE_ROW_BUDGET;
  return setting(configured, "maintenance_row_budget", {
    fallback: DEFAULT_MAINTENANCE_ROWS,
    minimum: MINIMUM_MAINTENANCE_ROWS,
    maximum: MAXIMUM_MAINTENANCE_ROWS,
  });
}
