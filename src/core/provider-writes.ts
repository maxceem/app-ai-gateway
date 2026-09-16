import { GatewayError } from "./errors";
import { andCondition, type PlanCap } from "./plan-caps";

/** Trusted transaction boundary supplied by a verified browser handoff or request receipt. */
export interface ProviderWriteBoundary {
  condition: { sql: string; params: unknown[] };
  commit(statement: D1PreparedStatement, outcome: Record<string, unknown>): Promise<void>;
}

export interface ProviderWriteActor {
  organizationId: string;
  userId: string;
}

/**
 * Runs one provider-family write under whatever conditions guard it.
 *
 * A `cap` is a plan ceiling on the resource being created. It is ANDed into the
 * statement's own WHERE rather than checked first, so the count and the insert
 * are one statement: two concurrent creates cannot both read a count below the
 * ceiling and then both write. That makes a capped refusal indistinguishable
 * from a lost race here — both simply change no rows — which is why the cap is
 * asked to explain itself on that path.
 */
export async function commitProviderWrite(
  env: Env,
  sql: string,
  parameters: unknown[],
  outcome: Record<string, unknown>,
  boundary?: ProviderWriteBoundary,
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

/** Ensures timestamp-based compare-and-swap also detects writes in the same millisecond. */
export function nextUpdatedAt(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
