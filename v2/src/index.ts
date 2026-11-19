/**
 * The v2 gateway Worker.
 *
 * Everything it serves is under `/v2`, so it can run beside v1 on the same
 * hostnames, with a Worker route for `/v2` and `/v2/*` (plan section 9.1,
 * test T23). Anything it does not declare is answered with a JSON 404.
 *
 * Step 1a part 1 serves only the health check. Provider requests, sign-in and
 * the management API are mounted by the steps that build them.
 */
import { Hono } from "hono";
import { CATALOG, type ErrorResponse, type OperationResponse } from "./contracts/catalog.ts";

const app = new Hono<{ Bindings: Env }>();

app.get(CATALOG.getHealth.path, (c) =>
  c.json({ ok: true, service: "app-ai-gateway", api: "v2" } satisfies OperationResponse<"getHealth">),
);

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Nothing is served at this path." } } satisfies ErrorResponse, 404),
);

app.onError((error, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", message: String(error) }));
  return c.json({ error: { code: "internal_error", message: "The gateway failed to handle this request." } } satisfies ErrorResponse, 500);
});

export default app satisfies ExportedHandler<Env>;
