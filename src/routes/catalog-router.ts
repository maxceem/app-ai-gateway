import type { Context, Env as HonoEnv, Hono } from "hono";
import { cfAuth } from "../auth/identity";
import {
  CATALOG,
  type BodiedOperation,
  type Catalog,
  type OperationName,
  type OperationResponse,
  type OperationSpec,
  type ParsedOperationQuery,
} from "../contracts/catalog";
import type { z } from "zod";
import { assertAccountAccess } from "../core/account-lifecycle";
import { GatewayError } from "../core/errors";
import type { AdminVariables } from "../middleware/admin";

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

/**
 * The authorization one operation asks for, with the defaults filled in.
 *
 * A `GET` reads and a member may; anything else writes and an admin may. Both
 * halves of that — who, and what standing the account itself needs — are the
 * entry's, never a method test or a path regex in `middleware/admin.ts`.
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
 * The order is fixed, so a caller short of two things is always told about the
 * same one.
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

/**
 * A query string through its operation's schema, or a 400 naming the first
 * parameter at fault. Most of these messages name their parameter already
 * ("limit must be…"); the rest are prefixed with it.
 */
function parsedQuery(schema: z.ZodType, raw: Record<string, string>): unknown {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const name = issue?.path.join(".") ?? "";
  const message = issue?.message ?? "Invalid query string";
  throw new GatewayError(
    400,
    "invalid_request",
    name === "" || message.startsWith(`${name} `) ? message : `${name}: ${message}`,
  );
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
 * `pnpm run check` at its own `return`. The path reaches the handler too, so
 * `c.req.param("app")` is a string rather than a maybe-string.
 *
 * Anything a response needs beyond its body — a cookie, a cache header — is set
 * on `c` before returning, as cf-auth already does when it writes the
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
  } = {},
) {
  const mount = (name: OperationName, handler: (c: Context<E>) => Promise<Response>): void => {
    const spec: OperationSpec = CATALOG[name];
    const guarded = spec.security === "management" || spec.security === "session";
    // Authorization is the entry's, so an entry that has some is never mounted
    // where it would not be applied: a route module cannot opt out of it by
    // building the wrong router.
    if (guarded && !options.authorized) {
      throw new Error(`${name} is a ${spec.security} operation and must be mounted through an authorizing router`);
    }
    const served = options.authorized
      ? async (c: Context<E>) => {
          if (guarded && options.authenticate) await options.authenticate(c);
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
      handler: (
        c: OperationContext<E, K>,
        input: { query: ParsedOperationQuery<K> },
      ) => OperationResponse<K> | Promise<OperationResponse<K>>,
    ): void {
      // The catalog's status is `200 | 201` for everything mounted here; the one
      // 302 in the table is the Google redirect, which answers with no body and
      // is served by better-auth rather than from this router.
      const spec: OperationSpec = CATALOG[name];
      const status = (spec.status ?? 200) as 200 | 201;
      mount(name, async (c) => {
        // Parsed after the policy has run, so a caller who may not ask is told
        // that rather than what is wrong with how they asked.
        const query = (spec.query ? parsedQuery(spec.query, c.req.query()) : {}) as ParsedOperationQuery<K>;
        return c.json(await handler(c as unknown as OperationContext<E, K>, { query }), status);
      });
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
