import type { Context, MiddlewareHandler } from "hono";
import {
  clientOf,
  cliVersionOf,
  endingOf,
  recordManagementCall,
  refusalOf,
  type CallEnding,
  type ManagementChannel,
  type ManagementCredential,
} from "../analytics/management";
import { bearerToken } from "../auth/bearer";
import { CATALOG, type OperationSpec } from "../contracts/catalog";
import { requestIdOf } from "../core/request-id";
import {
  asGatewayAuthError,
  CONSOLE_REQUEST_HEADER,
  isCfAuthError,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from "../auth/identity";
import type { AdminVariables } from "./admin";

type AnalyticsEnv = { Bindings: Env; Variables: AdminVariables };

/** The surfaces whose every request is a management call, matched or not. */
const MANAGEMENT_PATH = /^\/v1\/(?:admin|cli)(?:\/|$)/u;

/**
 * Records one data point per management call over HTTP: every catalog
 * operation the management app serves, and every request to the admin API or
 * the CLI's surface that is refused before one is matched — a credential that
 * does not authenticate, a path that is not there.
 *
 * Registered ahead of `adminAuth`, so its refusals are seen, and read after
 * the call: who the caller turned out to be is the `actor` the request
 * resolved, and how it ended is the response, or the error the client is
 * answered with. Does nothing at all where `MANAGEMENT_ANALYTICS` is unbound.
 * The MCP endpoint records its own, per tool call.
 */
export const managementAnalytics: MiddlewareHandler<AnalyticsEnv> = async (c, next) => {
  if (c.env.MANAGEMENT_ANALYTICS === undefined) return next();
  const started = Date.now();
  try {
    await next();
  } catch (error) {
    record(c, started, refusalOf(isCfAuthError(error) ? asGatewayAuthError(error) : error));
    throw error;
  }
  record(c, started, endingOf(c.res.status));
};

/**
 * Names the catalog operation a request was matched to, and the engine kind
 * it opens where it opens one. The catalog router calls it for every mounted
 * operation, before authenticating it, so a refusal is still attributed.
 */
export function noteManagementCall(c: Context, operation: string, kind?: string): void {
  const typed = c as unknown as Context<AnalyticsEnv>;
  if (typed.env?.MANAGEMENT_ANALYTICS === undefined) return;
  typed.set("managementOperation", operation);
  if (kind !== undefined) typed.set("managementKind", kind);
}

function record(c: Context<AnalyticsEnv>, started: number, ending: CallEnding): void {
  const matched = c.get("managementOperation");
  if (matched === undefined && !MANAGEMENT_PATH.test(c.req.path)) return;
  // A call refused before the router reached it — by `adminAuth`, say — is
  // still named by the operation its method and path ask for.
  const operation = matched ?? catalogOperation(c.req.method, c.req.path);
  const actor = c.get("actor");
  const credential = actor?.credentialType ?? presentedCredential(c);
  const userAgent = c.req.header("user-agent");
  recordManagementCall(c.env, {
    accountId: actor?.organizationId ?? null,
    channel: httpChannel(credential, c.req.header(CONSOLE_REQUEST_HEADER) === "1", userAgent),
    credential,
    identity: actor?.identityKind ?? null,
    operation: operation ?? null,
    tool: null,
    kind: c.get("managementKind") ?? null,
    outcome: ending.outcome,
    status: ending.status,
    code: ending.code,
    reason: ending.reason,
    field: ending.field,
    issue: ending.issue,
    client: clientOf(userAgent),
    clientVersion: cliVersionOf(userAgent),
    requestId: requestIdOf(c.req.header("cf-ray")),
    durationMs: Date.now() - started,
  });
}

interface CatalogRoute {
  name: string;
  method: string;
  pattern: RegExp;
  parameters: number;
}

let catalogRoutes: CatalogRoute[] | undefined;

/**
 * The catalog operation a method and path ask for, or null where none does.
 * Only its name is recorded, never a path parameter. Where two templates
 * match, the one with fewer parameters wins — `/apps/drafts` over
 * `/apps/{app}` — as the router's static routes win over its parameters.
 */
function catalogOperation(method: string, path: string): string | null {
  catalogRoutes ??= (Object.entries(CATALOG) as [string, OperationSpec][])
    .map(([name, spec]) => ({
      name,
      method: spec.method,
      pattern: new RegExp(
        `^${spec.path.replace(/[.*+?^$()|[\]\\]/gu, "\\$&").replace(/\{\w+\}/gu, "[^/]+")}$`,
        "u",
      ),
      parameters: spec.path.match(/\{\w+\}/gu)?.length ?? 0,
    }))
    .sort((a, b) => a.parameters - b.parameters);
  return catalogRoutes.find((route) => route.method === method && route.pattern.test(path))?.name ?? null;
}

/**
 * The credential a request presented, for one refused before it resolved
 * one: a bearer token by its prefix, else the console's session, which the
 * console's own request header stands for. Nothing of the credential itself.
 */
export function presentedCredential(c: { req: { header(name: string): string | undefined } }): ManagementCredential {
  const token = bearerToken(c.req.header("authorization"));
  if (token !== undefined) return token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? "oauth" : "apiKey";
  return c.req.header(CONSOLE_REQUEST_HEADER) === "1" ? "session" : "none";
}

/**
 * The console for a person's session or the console's own request; the CLI
 * for a client naming itself `agw`, which only the CLI does; the API for
 * everything else. A label for analytics, never a decision.
 */
function httpChannel(
  credential: ManagementCredential,
  consoleRequest: boolean,
  userAgent: string | undefined,
): ManagementChannel {
  if (credential === "session" || consoleRequest) return "console";
  return clientOf(userAgent) === "agw" ? "cli" : "api";
}
