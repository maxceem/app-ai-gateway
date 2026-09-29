import type { Context } from "hono";
import type { AdminVariables } from "../../middleware/admin";
export type CliEnv = { Bindings: Env; Variables: AdminVariables };
export type CliContext = Context<CliEnv>;
