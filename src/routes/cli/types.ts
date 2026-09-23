import type { Context } from "hono";
import type { AdminVariables } from "../../middleware/admin";
export type CliEnv = { Bindings: Env; Variables: AdminVariables };
export type CliContext = Context<CliEnv>;
export interface HandoffRow {
  id: string;
  kind: string;
  request_json: string;
  request_hash: string | null;
  target_id: string | null;
  target_revision: number | null;
  gateway_id: string | null;
  gateway_revision: number | null;
  snapshot_json: string | null;
  organization_id: string;
  initiating_user_id: string;
  initiating_credential_id: string;
  submission_proof_hash: string;
  poll_proof_hash: string;
  consumed_at: number | null;
  outcome: string | null;
  expires_at: number;
  created_at: number;
}
