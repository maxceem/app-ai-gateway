import type { AuthState } from "@maxceem/cf-auth";
import { and, eq } from "drizzle-orm";
import { cfAuth } from "../auth/identity";
import {
  CATALOG,
  type BodiedOperation,
  type Catalog,
  type OperationName,
  type OperationParams,
  type OperationResponse,
  type OperationSpec,
  type ParsedOperationQuery,
  type ParsedOperationRequest,
} from "../contracts/catalog";
import { assertAccountAccess } from "../core/account-lifecycle";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { app as appTable } from "../db/schema";
import type { AdminActor } from "./actor";
import type { ManagementScope } from "./scope";
import { parseRequest } from "./validation";

type AppRow = typeof appTable.$inferSelect;

/**
 * Everything a handler is handed, already parsed and resolved: the path
 * parameters, the query and the body through the operation's own schemas, the
 * request's management scope, the actor on an operation that has one, and the
 * application an `/apps/{app}` operation is about.
 */
export type OperationInput<K extends OperationName> = {
  params: OperationParams<K>;
  query: ParsedOperationQuery<K>;
  body: ParsedOperationRequest<K>;
  scope: ManagementScope;
} & (Catalog[K]["security"] extends "management" | "session" ? { actor: AdminActor } : unknown)
  & ("app" extends keyof OperationParams<K> ? { app: AppRow } : unknown);

/**
 * Who is asking, as whichever transport authenticated them hands it over: the
 * request's scope, and — for anyone who authenticated — the cf-auth state and
 * the one {@link AdminActor} it resolved to. A guarded operation refuses a
 * caller without `auth`.
 */
export interface OperationCaller {
  scope: ManagementScope;
  auth?: { state: AuthState; actor: AdminActor };
}

/**
 * The request as the transport received it: the path parameters its operation
 * names, and the query and body still unparsed. The body is read lazily, so a
 * body that is not even JSON is refused only once the policy has passed: a
 * caller who may not ask is told that rather than what is wrong with how they
 * asked.
 */
export interface OperationRequest<K extends OperationName> {
  params: OperationParams<K>;
  query: Record<string, string | string[]>;
  body?: () => Promise<unknown>;
}

/** A transport-independent handler: the operation's input in, its response body out. */
export type OperationHandler<K extends OperationName> = (
  input: OperationInput<K>,
) => OperationResponse<K> | Promise<OperationResponse<K>>;

/**
 * The authorization one operation asks for, with the defaults filled in.
 *
 * A `GET` reads and a member may; anything else writes and an admin may. Both
 * halves of that — who, and what standing the account itself needs — are the
 * entry's, never a method test or a path regex in `middleware/admin.ts`.
 */
export function operationPolicy(spec: OperationSpec) {
  const writes = spec.method !== "GET";
  return {
    role: spec.policy?.role ?? (writes ? "admin" : "member"),
    access: spec.policy?.access ?? (writes ? "setup" : "read"),
    session: spec.policy?.session === true,
    /** A session-only operation refuses a management key, however privileged. */
    sessionOnly: spec.security === "session",
  } as const;
}

/** Whether an operation's entry carries a policy, which is whether it needs a caller. */
function guarded(spec: OperationSpec): boolean {
  return spec.security === "management" || spec.security === "session";
}

function requireAuth(caller: OperationCaller): NonNullable<OperationCaller["auth"]> {
  if (!caller.auth) throw new GatewayError(401, "auth_required", "Authentication is required");
  return caller.auth;
}

/**
 * The application an `/apps/{app}` operation is about, found inside the
 * caller's account.
 *
 * Every operation under `/apps/{app}` is about an application that exists in
 * the caller's account; one that is not there is not there for any of them —
 * another account's included, so no transport can name one. A configuration
 * for an application that does not exist yet is validated at
 * `/app-drafts/validate` instead.
 */
async function resolveApp(caller: OperationCaller, appId: string | undefined): Promise<AppRow> {
  const { actor } = requireAuth(caller);
  if (!appId) throw new GatewayError(404, "app_not_found", "App is not registered");
  const row = await database(caller.scope.env.DB).query.app.findFirst({
    where: and(eq(appTable.id, appId), eq(appTable.organizationId, actor.organizationId)),
  });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  return row;
}

/**
 * Applies one operation's declared policy to the authenticated caller.
 *
 * The order is fixed, so a caller short of two things is always told about the
 * same one.
 */
async function authorize(spec: OperationSpec, caller: OperationCaller): Promise<void> {
  if (!guarded(spec)) return;
  const { state, actor } = requireAuth(caller);
  const policy = operationPolicy(spec);
  const { canManageOrganization, requireOrganization, requireUser } = await cfAuth();
  if (policy.role === "admin" && !canManageOrganization(actor.role)) {
    throw new GatewayError(
      403,
      "forbidden",
      "Only organization owners and admins can mutate gateway resources",
    );
  }
  if (policy.session) requireUser(state);
  requireOrganization(state, policy.role);
  await assertAccountAccess(caller.scope.deployment, caller.scope.env, actor.organizationId, policy.access);
  if (policy.sessionOnly && actor.credentialType !== "session") {
    throw new GatewayError(
      403,
      "session_required",
      "Management keys can only be administered from a user session",
    );
  }
  // Grant check (credential `read` vs a writing policy) goes here in a later step.
}

/**
 * The half of {@link runOperation} that decides whether the caller may ask at
 * all: the application an `/apps/{app}` operation names, then the entry's
 * policy. Exported for the transports that answer with something other than a
 * parsed body — a relayed `Response` — so nothing mounted from the catalog
 * skips it.
 */
export async function authorizeOperation<K extends OperationName>(
  name: K,
  caller: OperationCaller,
  request: OperationRequest<K>,
): Promise<AppRow | undefined> {
  const spec: OperationSpec = CATALOG[name];
  // Only read where the path names it, which is where `OperationParams<K>`
  // carries it; widened because `K` is generic here.
  const params: Partial<Record<string, string>> = request.params;
  // Resolved before the policy runs, as the application scope always has been:
  // an application that is not in the caller's account is not there, whoever
  // is asking.
  const app = spec.path.includes("{app}") ? await resolveApp(caller, params.app) : undefined;
  await authorize(spec, caller);
  return app;
}

/**
 * Runs one catalog operation for one caller, whichever transport received it.
 *
 * In this order, which is the one every caller observes: the application an
 * `/apps/{app}` operation names (404 `app_not_found`), the entry's policy, the
 * operation's own `before` refusal, the query, the body, and then the handler.
 */
export async function runOperation<K extends BodiedOperation>(
  name: K,
  caller: OperationCaller,
  request: OperationRequest<K>,
  handler: OperationHandler<K>,
  hooks: { before?: () => void | Promise<void> } = {},
): Promise<OperationResponse<K>> {
  const spec: OperationSpec = CATALOG[name];
  const schema = spec.request;
  if (schema !== undefined && "content" in schema) {
    throw new Error(`${name} takes a multipart body, which is not parsed through the executor`);
  }
  const app = await authorizeOperation(name, caller, request);
  if (hooks.before) await hooks.before();
  const query = spec.query ? parseRequest(spec.query, request.query) : {};
  const body = schema ? parseRequest(schema, request.body ? await request.body() : undefined) : undefined;
  const input = {
    params: request.params,
    query,
    body,
    scope: caller.scope,
    ...(guarded(spec) ? { actor: requireAuth(caller).actor } : {}),
    ...(app ? { app } : {}),
  } as unknown as OperationInput<K>;
  return handler(input);
}

/**
 * A table of handlers keyed by the operations they serve. A domain's handlers
 * are written `satisfies OperationHandlerTable`, which types each one by its
 * key and refuses a key that is not a catalog operation.
 */
export type OperationHandlerTable = { readonly [K in BodiedOperation]?: OperationHandler<K> };
