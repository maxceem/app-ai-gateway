import type { Context, Env as HonoEnv, Hono } from "hono";
import {
  CATALOG,
  type BodiedOperation,
  type Catalog,
  type OperationName,
  type OperationParams,
  type OperationResponse,
  type OperationSpec,
} from "../contracts/catalog";
import {
  authorizeOperation,
  runOperation,
  type OperationCaller,
  type OperationHandlerTable,
  type OperationInput,
  type OperationRequest,
} from "../management/executor";
import { OPERATION_HANDLERS, type RegisteredOperation } from "../management/handlers";
import type { AdminVariables } from "../middleware/admin";
import { jsonBody, managementScope } from "./admin/body";

/**
 * Every operation a route module has mounted through here.
 *
 * Exported so `test/catalog.test.ts` can compare it against the catalog itself:
 * the document and both client transports are derived from the catalog, so an
 * entry nobody serves is a documented endpoint that answers 404.
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

type AuthorizedContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

function guarded(spec: OperationSpec): boolean {
  return spec.security === "management" || spec.security === "session";
}

/**
 * Who is asking, as the executor takes it: the request's scope, and on a guarded
 * operation the `authState` and `actor` that `adminAuth` or the surface's own
 * `authenticate` established on the context.
 */
function operationCaller(c: AuthorizedContext, spec: OperationSpec): OperationCaller {
  const scope = managementScope(c);
  if (!guarded(spec)) return { scope };
  const state = c.get("authState");
  const actor = c.get("actor");
  return state && actor ? { scope, auth: { state, actor } } : { scope };
}

/** What a mounted handler is handed: the request, typed by the catalog's path. */
export type OperationContext<E extends HonoEnv, K extends OperationName> =
  Context<E, HonoPath<Catalog[K]["path"]>>;

/** A handler that needs the HTTP request itself, beside its parsed input. */
export type HttpOperationHandler<E extends HonoEnv, K extends BodiedOperation> = (
  c: OperationContext<E, K>,
  input: OperationInput<K>,
) => OperationResponse<K> | Promise<OperationResponse<K>>;

/**
 * Mounts catalog operations on the paths the catalog declares: the HTTP
 * adapter over `runOperation`.
 *
 * A handler returns the operation's response body and nothing else: the method,
 * the path and the success status come from the entry, and the body's type is
 * the entry's response schema, so a handler that drifts from the contract fails
 * `pnpm run check` at its own `return`. The executor resolves the application,
 * applies the entry's policy and parses the path, the query and the body, so a
 * service is handed a typed body and never parses one itself.
 *
 * An operation in the handler registry is mounted by name alone. One that needs
 * the request — anything a response carries beyond its body, a cookie, a
 * cache header — is mounted with a handler of its own, which sets that on `c`
 * before returning, as cf-auth already does when it writes the
 * current-organization cookie.
 */
export function catalogRouter<E extends HonoEnv>(
  app: Hono<E>,
  base: string,
  options: {
    authorized?: boolean;
    /**
     * Establishes `authState` and `actor` for a management or session entry,
     * where the surface is not already behind a middleware that does. Runs
     * right before the entry's policy is applied.
     */
    authenticate?: (c: Context<E>) => Promise<void>;
    /**
     * Reads a request body before its schema parses it. The same refusal for
     * an unparseable body everywhere unless a surface has limits of its own.
     */
    readBody?: (c: Context<E>) => Promise<unknown>;
  } = {},
) {
  const readBody = options.readBody ?? jsonBody;
  const mount = (name: OperationName, handler: (c: Context<E>) => Promise<Response>): void => {
    const spec: OperationSpec = CATALOG[name];
    // Authorization is the entry's, so an entry that has some is never mounted
    // where it would not be applied: a route module cannot opt out of it by
    // building the wrong router.
    if (guarded(spec) && !options.authorized) {
      throw new Error(`${name} is a ${spec.security} operation and must be mounted through an authorizing router`);
    }
    const served = async (c: Context<E>) => {
      if (guarded(spec) && options.authenticate) await options.authenticate(c);
      return handler(c);
    };
    app.on(spec.method, honoPath(spec.path, base), served as never);
    MOUNTED_OPERATIONS.add(name);
  };

  /**
   * The request as the executor takes it: raw, with the body read only when
   * asked for. Hono matched the catalog's own path to get here, so the
   * parameters it bound are exactly the ones that path names — the one place
   * that is known rather than checked.
   */
  const operationRequest = <K extends OperationName>(c: Context<E>): OperationRequest<K> => ({
    params: c.req.param() as Record<string, string> as OperationParams<K>,
    query: c.req.query(),
    body: () => readBody(c),
  });

  function handle<K extends RegisteredOperation>(name: K): void;
  function handle<K extends BodiedOperation>(
    name: K,
    handler: HttpOperationHandler<E, K>,
    options?: {
      /**
       * A refusal of this operation's own that must come before its body is
       * read: after the policy, before any parsing.
       */
      before?: (c: OperationContext<E, K>) => void | Promise<void>;
    },
  ): void;
  function handle<K extends BodiedOperation>(
    name: K,
    handler?: HttpOperationHandler<E, K>,
    handleOptions: { before?: (c: OperationContext<E, K>) => void | Promise<void> } = {},
  ): void {
    // Catalog-mounted handlers answer with a body and a 200 or 201 status.
    // Better Auth serves the social sign-in flow outside this router.
    const spec: OperationSpec = CATALOG[name];
    const status = (spec.status ?? 200) as 200 | 201;
    const request = spec.request;
    if (request !== undefined && "content" in request) {
      throw new Error(`${name} takes a multipart body, which is not parsed through this router`);
    }
    const registered = (OPERATION_HANDLERS as OperationHandlerTable)[name];
    if (!handler && !registered) throw new Error(`${name} has no registered handler to mount`);
    mount(name, async (c) => {
      const context = c as unknown as OperationContext<E, K>;
      const result = await runOperation(
        name,
        operationCaller(c as unknown as AuthorizedContext, spec),
        operationRequest<K>(c),
        handler ? (input) => handler(context, input) : registered!,
        handleOptions.before ? { before: () => handleOptions.before!(context) } : {},
      );
      return c.json(result, status);
    });
  }

  return {
    handle,

    /**
     * The same mount for the two handoff endpoints that relay another system's
     * `Response` verbatim — Better Auth's sign-up, and its social sign-in with
     * the claim cookie appended. Their status and their `Set-Cookie` headers are
     * the answer, not just their body, so there is nothing for this router to
     * assemble. The path still comes from the catalog, which is what keeps them
     * from being a second place a URL is written, and the entry's policy still
     * runs first.
     */
    relay<K extends OperationName>(
      name: K,
      handler: (c: OperationContext<E, K>) => Promise<Response>,
    ): void {
      const spec: OperationSpec = CATALOG[name];
      mount(name, async (c) => {
        await authorizeOperation(
          name,
          operationCaller(c as unknown as AuthorizedContext, spec),
          operationRequest<K>(c),
        );
        return handler(c as unknown as OperationContext<E, K>);
      });
    },
  };
}

/**
 * The same router for the authenticated management surface.
 *
 * Everything mounted through it runs its operation's catalog policy first, so
 * a route module never restates who may call it.
 */
export function adminRouter<E extends HonoEnv>(app: Hono<E>, base = "/v1/admin") {
  return catalogRouter(app, base, { authorized: true });
}
