import { log } from "./log";

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
 * The real database behind a wrapper, so a view can wrap it for itself.
 *
 * A sweep is handed the run's database and, when it is given a share of the
 * allowance, has to issue through that share instead. Wrapping the wrapper
 * would charge the run twice; unwrapping first means
 * `share.database(runDatabase)` is simply the same database seen through the
 * share, which is what every caller means by it.
 */
const WRAPPED_DATABASES = new WeakMap<D1Database, D1Database>();

/**
 * A scheduled run's query allowance, counting the statements actually issued.
 *
 * Mutable and shared rather than returned, so that a sweep which throws partway
 * still leaves an accurate count behind for the sweep after it, and so the
 * nightly run can hand what one sweep did not spend to the next.
 *
 * Nothing declares its own cost to this: a sweep is given
 * {@link QueryBudget.database} and is charged for what it issues, so a sweep
 * cannot drift from a constant that promised what it would spend. A loop that
 * must finish a step it starts asks {@link QueryBudget.affords} first; anything
 * else simply runs until a statement is refused.
 */
export class QueryBudget {
  #spent = 0;
  readonly #parent: QueryBudget | undefined;

  constructor(readonly limit: number, parent?: QueryBudget) {
    this.limit = Math.max(0, limit);
    this.#parent = parent;
  }

  /** Statements issued through this budget so far. */
  get spent(): number {
    return this.#spent;
  }

  /** Statements this budget can still pay for. */
  get remaining(): number {
    const own = Math.max(0, this.limit - this.#spent);
    return this.#parent === undefined ? own : Math.min(own, this.#parent.remaining);
  }

  /** Whether `n` more statements fit. Loops ask this before starting a step they must finish. */
  affords(n: number): boolean {
    return this.remaining >= n;
  }

  /** Charges `n`; throws {@link QueryBudgetExhausted} rather than exceeding the limit. */
  charge(n: number): void {
    if (this.#spent + n > this.limit) throw new QueryBudgetExhausted(this.limit);
    // Before this budget's own tally, so a parent that refuses leaves nothing
    // charged anywhere, and reports its own limit rather than this view's.
    this.#parent?.charge(n);
    this.#spent += n;
  }

  /**
   * A view limited to `n` statements of this budget's remaining allowance.
   *
   * A charge on the view charges this budget too, so whatever the view does not
   * spend is still here — there is no "return what was declined" arithmetic to
   * get wrong, and a view that is simply dropped costs exactly what it issued.
   */
  limited(n: number): QueryBudget {
    return new QueryBudget(n, this);
  }

  /**
   * D1 as seen through this budget: every statement charges before it is issued.
   *
   * Statements are counted rather than calls, so a `batch` of seventeen costs
   * seventeen. That is the conservative reading of D1's per-invocation query
   * limit: a batch is one transaction but not one subrequest.
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
 * Queries one nightly maintenance run may issue, across every sweep.
 *
 * D1 queries are subrequests, and a Worker invocation may issue 1,000 of them
 * on the Workers Paid plan but only **50** on the Free plan. This project is
 * meant to be easy to self-host, so the default is the Free one: exceeding it
 * would not corrupt anything — every chunk the retention pass commits is its
 * own transaction — but it would throw on a query every night, and take the
 * passes after it down with it, which is a bad way to discover a limit.
 */
export const DEFAULT_MAINTENANCE_QUERY_BUDGET = 50;

/** Left unspent, so a miscount in one sweep cannot reach the platform ceiling. */
export const MAINTENANCE_SLACK_QUERIES = 1;

/** Below this a run cannot complete a single useful pass, so it is not honoured. */
const MINIMUM_MAINTENANCE_QUERY_BUDGET = 20;

/**
 * The allowance for one nightly run, raised by `MAINTENANCE_QUERY_BUDGET`.
 *
 * Deliberately not a `vars` entry in `wrangler.jsonc`: the Deploy to Cloudflare
 * form shows every one of those as a field, and a deployment that never outgrows
 * the Free plan — which is most of them — should not have to answer a question
 * about D1 subrequest ceilings to install this gateway. A deployment on the
 * Workers Paid plan sets it in the dashboard or in a profile overlay once it has
 * a retention backlog worth draining faster.
 */
export function maintenanceQueryBudget(env: Env): QueryBudget {
  const configured = env.MAINTENANCE_QUERY_BUDGET;
  const budget = (allowance: number) =>
    new QueryBudget(allowance - MAINTENANCE_SLACK_QUERIES);
  if (configured === undefined || configured.trim() === "")
    return budget(DEFAULT_MAINTENANCE_QUERY_BUDGET);
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < MINIMUM_MAINTENANCE_QUERY_BUDGET) {
    log("warn", "maintenance_query_budget_invalid", {
      configured,
      minimum: MINIMUM_MAINTENANCE_QUERY_BUDGET,
      using: DEFAULT_MAINTENANCE_QUERY_BUDGET,
    });
    return budget(DEFAULT_MAINTENANCE_QUERY_BUDGET);
  }
  return budget(parsed);
}
