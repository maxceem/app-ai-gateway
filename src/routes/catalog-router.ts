import type { Context, Env as HonoEnv, Hono } from "hono";
import { cfAuth } from "../auth/identity";
import {
  CATALOG,
  type BodiedOperation,
  type Catalog,
  type OperationName,
  type OperationResponse,
  type OperationSpec,
} from "../contracts/catalog";
import { assertAccountAccess } from "../core/account-lifecycle";
import { GatewayError } from "../core/errors";
import type { AdminVariables } from "../middleware/admin";

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

/**
 * The authorization one operation asks for, with the defaults filled in.
 *
 * A `GET` reads and a member may; anything else writes and an admin may. Both
 * halves of that — who, and what standing the account itself needs — used to
 * be a `method`-plus-path-regex decision in `middleware/admin.ts`, which every
 * new route had to remember to update.
 */
function operationPolicy(spec: OperationSpec) {
  const writes = spec.method !== "GET";
  return {
    role: spec.policy?.role ?? (writes ? "admin" : "member"),
    access: spec.policy?.access ?? (writes ? "setup" : "read"),
    identity: spec.policy?.identity,
    /** A session-only operation refuses a management key, however privileged. */
    sessionOnly: spec.security === "session",
  } as const;
}

/**
 * Applies one operation's declared policy to the authenticated caller.
 *
 * Runs after `adminAuth`, which established who is asking and nothing more.
 * The order is the order the refusals used to arrive in, so a caller that was
 * short of two things is still told about the same one.
 */
type AuthorizedContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

async function authorize(c: AuthorizedContext, spec: OperationSpec): Promise<void> {
  if (spec.security !== "management" && spec.security !== "session") return;
  const policy = operationPolicy(spec);
  const { canManageOrganization, requireOrganization, requireUser } = await cfAuth();
  const state = c.get("authState");
  const actor = c.get("actor");
  if (policy.role === "admin" && !canManageOrganization(actor.role)) {
    throw new GatewayError(
      403,
      "forbidden",
      "Only organization owners and admins can mutate gateway resources",
    );
  }
  if (policy.identity === "human") requireUser(state);
  requireOrganization(state, policy.role);
  await assertAccountAccess(c.get("deployment"), c.env, actor.organizationId, policy.access);
  if (policy.sessionOnly && actor.credentialType !== "session") {
    throw new GatewayError(
      403,
      "session_required",
      "Management keys can only be administered from a user session",
    );
  }
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
export function catalogRouter<E extends HonoEnv>(
  app: Hono<E>,
  base: string,
  options: { authorized?: boolean } = {},
) {
  const mount = (name: OperationName, handler: (c: Context<E>) => Promise<Response>): void => {
    const spec: OperationSpec = CATALOG[name];
    const served = options.authorized
      ? async (c: Context<E>) => {
          await authorize(c as unknown as AuthorizedContext, spec);
          return handler(c);
        }
      : handler;
    app.on(spec.method, honoPath(spec.path, base), served as never);
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

/**
 * The same router for the authenticated management surface.
 *
 * Everything mounted through it runs its operation's catalog policy first, so
 * a route module never restates who may call it.
 */
export function adminRouter<E extends HonoEnv>(app: Hono<E>, base = "/v1/admin") {
  return catalogRouter(app, base, { authorized: true });
}
