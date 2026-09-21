import { GatewayError } from "../core/errors";
import { andCondition, type SqlCondition } from "../policy/sql";
import type { PlanCap } from "./plan-caps";
import type { ManagementScope } from "./scope";

/** Trusted transaction boundary supplied by a verified browser handoff or request receipt. */
export interface ResourceWriteBoundary {
  condition: SqlCondition;
  /**
   * Commits the guarded write together with whatever the boundary itself has
   * to record. One statement or several: a create that also mints a key writes
   * two rows, and both shapes go through this one path.
   */
  commit(
    statement: D1PreparedStatement | D1PreparedStatement[],
    outcome: Record<string, unknown>,
  ): Promise<void>;
}

/** Runs one resource write under its atomic authorization and cap conditions. */
export async function commitResourceWrite(
  scope: ManagementScope,
  sql: string,
  parameters: unknown[],
  outcome: Record<string, unknown>,
  boundary?: ResourceWriteBoundary,
  cap?: PlanCap,
): Promise<void> {
  const condition = andCondition(boundary?.condition, cap?.condition);
  const statement = scope.env.DB.prepare(sql.replace("/* authorization */", condition.sql)).bind(
    ...parameters,
    ...condition.params,
  );
  if (boundary) {
    try {
      await boundary.commit(statement, outcome);
    } catch (error) {
      await cap?.assertNotReached();
      throw error;
    }
    return;
  }
  const result = await statement.run();
  if (result.meta.changes !== 1) {
    await cap?.assertNotReached();
    throw new GatewayError(409, "conflict", "The resource changed; fetch it and retry");
  }
}
