import type { Context } from "hono";
import type { AdminVariables } from "../../middleware/admin";
export type CliEnv = { Bindings: Env; Variables: AdminVariables };
export type CliContext = Context<CliEnv>;

/** One `mgmt_operation` row, as SQL returns it; see the table's own description. */
export interface OperationRow {
  id: string;
  kind: string;
  state: "pending" | "completed" | "retired" | "expired";
  organization_id: string | null;
  initiating_user_id: string | null;
  initiating_credential_id: string | null;
  request_json: string | null;
  request_hash: string;
  browser_proof_hash: string | null;
  outcome_json: string | null;
  sealed_outcome: string | null;
  sealed_until: number | null;
  credential_id: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}
