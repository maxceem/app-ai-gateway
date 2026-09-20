import { GatewayError } from "../core/errors";
import { andCondition, type PlanCap } from "../core/plan-caps";

/** Trusted transaction boundary supplied by a verified browser handoff or request receipt. */
export interface ResourceWriteBoundary {
  condition: { sql: string; params: unknown[] };
  commit(statement: D1PreparedStatement, outcome: Record<string, unknown>): Promise<void>;
}

export interface ResourceWriteActor {
  organizationId: string;
  userId: string;
}

/** Runs one resource write under its atomic authorization and cap conditions. */
export async function commitResourceWrite(
  env: Env,
  sql: string,
  parameters: unknown[],
  outcome: Record<string, unknown>,
  boundary?: ResourceWriteBoundary,
  cap?: PlanCap,
): Promise<void> {
  const condition = andCondition(boundary?.condition, cap?.condition);
  const statement = env.DB.prepare(sql.replace("/* authorization */", condition.sql)).bind(
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
