import type { Context } from "hono";
import type { AdminVariables } from "../../middleware/admin";
export type CliEnv = { Bindings: Env; Variables: AdminVariables };
export type CliContext = Context<CliEnv>;
export interface HandoffRow {
  id: string;
  kind: string;
  request_json: string;
  organization_id: string;
  initiating_user_id: string;
  initiating_credential_id: string;
  submission_proof_hash: string;
  poll_proof_hash: string;
  human_code_hash: string | null;
  consumed_at: number | null;
  outcome: string | null;
  expires_at: number;
  created_at: number;
}
