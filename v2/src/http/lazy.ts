/**
 * Mounting a group of routes that is evaluated only when a request needs it
 * (v1's `src/routes/lazy.ts`, ported).
 *
 * What this buys is deferred evaluation, not a smaller bundle: Wrangler
 * inlines the module as a wrapper that runs on first use. The management
 * code, its schemas and the sign-in library then cost a provider request's
 * cold start nothing.
 *
 * The loaded module is kept once per isolate. A failed load is forgotten, so
 * a passing failure does not answer every later request in the isolate.
 *
 * The request goes through untouched: the inner app uses the same absolute
 * paths. An error the inner app throws comes out of its `fetch` as a
 * rejection, so the entry module's `onError` formats it like any other.
 */
import type { Env as HonoEnv, ExecutionContext as HonoExecutionContext, Handler } from "hono";

/** What a lazily mounted group exposes. A `Hono` app satisfies it. */
export interface RouteBundle {
  fetch: (request: Request, env: Env, executionCtx?: HonoExecutionContext) => Response | Promise<Response>;
}

export function lazyRoutes<E extends HonoEnv & { Bindings: Env }>(load: () => Promise<RouteBundle>): Handler<E> {
  let loaded: Promise<RouteBundle> | undefined;
  return async (c) => {
    const routes = await (loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    }));
    // A test may call the Worker with no execution context, and reading one
    // Hono does not have throws.
    let executionCtx: HonoExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    return routes.fetch(c.req.raw, c.env, executionCtx);
  };
}
