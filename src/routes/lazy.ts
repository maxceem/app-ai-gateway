import type { Env as HonoEnv, ExecutionContext as HonoExecutionContext, Handler } from "hono";

/**
 * What a lazily mounted bundle has to expose. A `Hono` app's own `fetch`
 * satisfies it, so nothing in this module has to name Hono's route generics.
 *
 * The execution context is Hono's own narrower interface rather than the
 * Workers global of the same name, because that is what `Context.executionCtx`
 * hands back and what `fetch` accepts.
 */
export interface RouteBundle {
  fetch: (
    request: Request,
    env: Env,
    executionCtx?: HonoExecutionContext,
  ) => Response | Promise<Response>;
}

/**
 * Mounts a route bundle that is only evaluated once a request needs it.
 *
 * Two thirds of this Worker's startup CPU used to be spent evaluating modules a
 * proxied request never touches. A dynamic `import()` behind this handler moves
 * that off the cold start of every request that is not a management call, the
 * same way App Attest is deferred inside the handlers that attest in `./auth`.
 *
 * What is left behind it is the operation catalog and the zod request and
 * response schemas it composes — measured at about 20ms of startup CPU, which
 * is why the management surface is still mounted this way rather than
 * statically. The identity library is not: better-auth and the
 * `@opentelemetry` semantic conventions it pulls in used to enter the bundle
 * here too, and are now deferred per function through `cfAuth()` in
 * `../auth/identity`, which is what lets everything else on the client path —
 * the application token exchange included — mount on the entry app directly.
 *
 * What this buys is deferred *evaluation*, not a smaller bundle: wrangler does
 * not emit a separate chunk here, it inlines the module as a lazily initialised
 * wrapper that runs on first use. The file stays the same size; the work moves.
 *
 * The loader's promise is memoised per mount, so the module is evaluated once
 * per isolate however many requests arrive. A rejection is forgotten instead of
 * being kept, because a pinned failed promise would answer every later request
 * in the isolate with a transient failure the next one might not have hit.
 *
 * The original request is passed through untouched. The inner app mirrors the
 * outer path prefixes, so there is nothing to rewrite, and handlers that compare
 * `c.req.path` against absolute paths — `./admin` and `../middleware/admin` both
 * do — keep seeing the path the client sent.
 *
 * Errors are the inner app's to map and the outer app's to format: an inner
 * `onError` that throws propagates out of `fetch()` as a rejection, because
 * Hono's `#handleError` calls `errorHandler` without catching it and `compose`
 * awaits it inside the `catch` it was reached from (see
 * `node_modules/hono/dist/hono-base.js` and `compose.js`). So the entry module's
 * `onError` still formats and logs every failure exactly as it did when these
 * routes were mounted statically.
 */
export function lazyRoutes<E extends HonoEnv & { Bindings: Env }>(
  load: () => Promise<RouteBundle>,
): Handler<E> {
  let loaded: Promise<RouteBundle> | undefined;
  return async (c) => {
    const routes = await (loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    }));
    // The test suite calls `app.request(url, init, env)` with no execution
    // context, and reading one Hono does not have throws rather than answering
    // undefined. `fetch` accepts undefined, so this simply forwards what there
    // is; `waitUntil` inside the bundle behaves as it does on the outer app.
    let executionCtx: HonoExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    return routes.fetch(c.req.raw, c.env, executionCtx);
  };
}
