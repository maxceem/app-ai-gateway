import { Hono } from "hono";
import { OPERATION_HANDLERS } from "../../management/handlers";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { assertConsoleOrigin } from "../console-origin";

/**
 * Where an operation opened by the CLI or an MCP tool stands, and the reveal
 * of a key it created, which the console's reveal page calls.
 */
export const operationRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(operationRoutes);

routes.handle("getOperation");
// The one answer that carries a key's value goes only to the console's own
// page, behind the same boundary as the CLI's browser handoff: checked after
// the catalog policy, before anything is revealed.
routes.handle("revealOperation", (_c, input) => OPERATION_HANDLERS.revealOperation(input), {
  before: assertConsoleOrigin,
});
