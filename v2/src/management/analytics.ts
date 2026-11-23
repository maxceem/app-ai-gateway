/**
 * Management analytics over HTTP (v1's `managementAnalytics` middleware,
 * ported): one data point per call to the management API (`/v2/admin/*`) or
 * the CLI's surface (`/v2/cli/*`), matched or not. What is written is
 * declared in `src/analytics/management.ts`, and nothing else is.
 *
 * Registered first in the management app, so the refusals of `adminAuth` are
 * seen, and read after the call: who the caller turned out to be is the
 * `actor` the request resolved, and how it ended is the response, or the error
 * the client is answered with. Does nothing at all where `MANAGEMENT_ANALYTICS`
 * is unbound.
 *
 * Not recorded here: the operation a tool runs on its caller's behalf (an MCP
 * or CLI tool call), since the call itself is recorded once, where it arrived;
 * and the MCP endpoint, which records its own, per tool call.
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  clientOf,
  cliVersionOf,
  endingOf,
  isCliAgent,
  managementDataset,
  recordManagementCall,
  refusalOf,
  token,
  type CallEnding,
  type ManagementChannel,
  type ManagementCredential,
} from "../analytics/management.ts";
import { bearerToken, isPresetCall, type AdminVariables } from "../admin/actor.ts";
import { credentialRefusalReason } from "../admin/credential-refusal.ts";
import { CONSOLE_REQUEST_HEADER, gatewayErrorOf, OAUTH_ACCESS_TOKEN_PREFIX } from "../auth/identity.ts";
import { CATALOG, type OperationName } from "../contracts/catalog.ts";
import { requestIdOf } from "../core/request-id.ts";

type AnalyticsEnv = { Bindings: Env; Variables: Partial<AdminVariables> };

/** The surfaces whose every request is a management call, matched or not. */
const MANAGEMENT_PATH = /^\/v2\/(?:admin|cli)(?:\/|$)/u;

export const managementAnalytics: MiddlewareHandler<AnalyticsEnv> = async (c, next) => {
  if (managementDataset(c.env) === null || isPresetCall(c.req.raw) || !MANAGEMENT_PATH.test(c.req.path)) return next();
  const started = Date.now();
  try {
    await next();
  } catch (error) {
    record(c, started, refusalOf(gatewayErrorOf(error)));
    throw error;
  }
  record(c, started, endingOf(c.res.status));
};

function record(c: Context<AnalyticsEnv>, started: number, ending: CallEnding): void {
  const operation = catalogOperation(c.req.method, c.req.path);
  const actor = c.get("actor");
  const credential = actor?.credentialType ?? presentedCredential(c);
  const userAgent = c.req.header("user-agent");
  recordManagementCall(c.env, {
    accountId: actor?.accountId ?? null,
    channel: httpChannel(credential, c.req.header(CONSOLE_REQUEST_HEADER) === "1", userAgent),
    credential,
    identity: actor === undefined ? null : "human",
    operation,
    // The tool a CLI tool call names, by the name its path carries; `token` drops anything else.
    tool: operation === "callCliTool" ? token(decodeSegment(c.req.path.split("/").pop())) : null,
    kind: null,
    outcome: ending.outcome,
    status: ending.status,
    code: ending.code,
    reason: ending.reason ?? (ending.code === "auth_required" ? credentialRefusalReason((name) => c.req.header(name)) : null),
    field: ending.field,
    issue: ending.issue,
    client: clientOf(userAgent),
    clientVersion: cliVersionOf(userAgent),
    requestId: requestIdOf(c.req.header("cf-ray")),
    durationMs: Date.now() - started,
  });
}

function decodeSegment(segment: string | undefined): string | undefined {
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

interface CatalogRoute {
  name: OperationName;
  method: string;
  pattern: RegExp;
  parameters: number;
}

let catalogRoutes: CatalogRoute[] | undefined;

/**
 * The catalog operation a method and path ask for, or null where none does.
 * Only its name is recorded, never a path parameter. Where two templates
 * match, the one with fewer parameters wins, as the router's static routes
 * win over its parameters.
 */
function catalogOperation(method: string, path: string): OperationName | null {
  catalogRoutes ??= (Object.entries(CATALOG) as [OperationName, { method: string; path: string }][])
    .map(([name, spec]) => ({
      name,
      method: spec.method.toUpperCase(),
      pattern: new RegExp(`^${spec.path.replace(/[.*+?^$()|[\]\\]/gu, "\\$&").replace(/\{\w+\}/gu, "[^/]+")}$`, "u"),
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
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer !== undefined) return bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? "oauth" : "apiKey";
  return c.req.header(CONSOLE_REQUEST_HEADER) === "1" ? "session" : "none";
}

/**
 * The console for a person's session or the console's own request; the CLI
 * for a client naming itself `agw` first, which only the CLI does; the API for
 * everything else. A label for analytics, never a decision.
 */
function httpChannel(credential: ManagementCredential, consoleRequest: boolean, userAgent: string | undefined): ManagementChannel {
  if (credential === "session" || consoleRequest) return "console";
  return isCliAgent(userAgent) ? "cli" : "api";
}
