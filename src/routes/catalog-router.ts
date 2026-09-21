import type { Context, Env as HonoEnv, Hono } from "hono";
import {
  CATALOG,
  type BodiedOperation,
  type Catalog,
  type OperationName,
  type OperationResponse,
} from "../contracts/catalog";

/**
 * Every operation a route module has mounted through here.
 *
 * Exported so `test/catalog.test.ts` can compare it against the catalog itself:
 * the document and both client transports are derived from the catalog, so an
 * entry nobody serves is a documented endpoint that answers 404, and that used
 * to be undetectable.
 */
export const MOUNTED_OPERATIONS = new Set<OperationName>();

/** An OpenAPI template as Hono spells it: `/apps/{app}` becomes `/apps/:app`. */
type HonoPath<P extends string> =
  P extends `${infer Head}{${infer Name}}${infer Tail}` ? `${Head}:${Name}${HonoPath<Tail>}` : P;

/** The same conversion at runtime, with `base` stripped off the front. */
function honoPath(template: string, base: string): string {
  const relative = template.startsWith(base) ? template.slice(base.length) : template;
  return (relative || "/").replace(/\{(\w+)\}/gu, ":$1");
}

/** What a mounted handler is handed: the request, typed by the catalog's path. */
export type OperationContext<E extends HonoEnv, K extends OperationName> =
  Context<E, HonoPath<Catalog[K]["path"]>>;

/**
 * Mounts handlers on the paths the catalog declares.
 *
 * A handler returns the operation's response body and nothing else: the method,
 * the path and the success status come from the entry, and the body's type is
 * the entry's response schema, so a handler that drifts from the contract fails
 * `pnpm run check` at its own `return`. That is what the `satisfies` annotations
 * on these handlers used to do by hand, one per route, with nothing tying the
 * annotation to the path the route was mounted on. The path reaches the handler
 * too, so `c.req.param("app")` is a string rather than a maybe-string.
 *
 * Anything a response needs beyond its body — a cookie, a cache header — is set
 * on `c` before returning, as cf-auth already does when it writes the
 * current-organization cookie.
 */
export function catalogRouter<E extends HonoEnv>(app: Hono<E>, base: string) {
  const mount = (name: OperationName, handler: (c: Context<E>) => Promise<Response>): void => {
    app.on(CATALOG[name].method, honoPath(CATALOG[name].path, base), handler as never);
    MOUNTED_OPERATIONS.add(name);
  };

  return {
    handle<K extends BodiedOperation>(
      name: K,
      handler: (c: OperationContext<E, K>) => OperationResponse<K> | Promise<OperationResponse<K>>,
    ): void {
      // The catalog's status is `200 | 201` for everything mounted here; the one
      // 302 in the table is the Google redirect, which answers with no body and
      // is served by better-auth rather than from this router.
      const status = ((CATALOG[name] as { status?: number }).status ?? 200) as 200 | 201;
      mount(name, async (c) =>
        c.json(await handler(c as unknown as OperationContext<E, K>), status));
    },

    /**
     * The same mount for the two handoff endpoints that relay another system's
     * `Response` verbatim — Better Auth's sign-up, and its social sign-in with
     * the claim cookie appended. Their status and their `Set-Cookie` headers are
     * the answer, not just their body, so there is nothing for this router to
     * assemble. The path still comes from the catalog, which is what keeps them
     * from being a second place a URL is written.
     */
    relay<K extends OperationName>(
      name: K,
      handler: (c: OperationContext<E, K>) => Promise<Response>,
    ): void {
      mount(name, (c) => handler(c as unknown as OperationContext<E, K>));
    },
  };
}
