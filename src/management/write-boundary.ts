import { and, sql, type SQL } from "drizzle-orm";
import { GatewayError } from "../core/errors";
import { prepared } from "../db/sql";
import type { PlanCap } from "./plan-caps";
import type { ManagementScope } from "./scope";

/** Trusted transaction boundary supplied by the CLI operation a write runs under. */
export interface ResourceWriteBoundary {
  /** Holds while the operation may still write; ANDed into the write's guard. */
  condition: SQL;
  /**
   * Commits the guarded write together with whatever the boundary itself has
   * to record. A create that also mints a key writes two rows, so this always
   * takes the whole list.
   */
  commit(statements: D1PreparedStatement[], outcome: Record<string, unknown>): Promise<void>;
}

/**
 * Runs one resource write under its atomic authorization and cap conditions.
 *
 * `build` receives the guard — the boundary's condition and the plan cap's,
 * or `1` when there is neither — and embeds it in the statements it returns,
 * so the check and the write are one statement and a concurrent change cannot
 * land between them. Every value in those statements is bound where it appears
 * in the template.
 *
 * Under a boundary, the boundary commits them. Otherwise they run as one batch,
 * and the first statement is the write that must have changed exactly one row:
 * a guard refuses by matching nothing, which is answered with the plan's own
 * refusal when the ceiling is what stopped it and with a conflict otherwise.
 */
export async function commitResourceWrite(
  scope: ManagementScope,
  build: (guard: SQL) => SQL | SQL[],
  outcome: Record<string, unknown>,
  options: { boundary?: ResourceWriteBoundary; cap?: PlanCap; conflict?: string } = {},
): Promise<void> {
  const { boundary, cap } = options;
  const guard = and(boundary?.condition, cap?.condition) ?? sql`1`;
  const built = build(guard);
  const statements = (Array.isArray(built) ? built : [built])
    .map((statement) => prepared(scope.env.DB, statement));
  if (boundary) {
    try {
      await boundary.commit(statements, outcome);
    } catch (error) {
      await cap?.assertNotReached();
      throw error;
    }
    return;
  }
  const [written] = await scope.env.DB.batch(statements);
  if (written?.meta.changes !== 1) {
    await cap?.assertNotReached();
    throw new GatewayError(
      409,
      "conflict",
      options.conflict ?? "The resource changed; fetch it and retry",
    );
  }
}
