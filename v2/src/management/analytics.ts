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
  endingOf,
  managementDataset,
  recordManagementCall,
  refusalOf,
  userAgentOf,
  type CallEnding,
  type ManagementChannel,
  type ManagementCredential,
} from "../analytics/management.ts";
import { isPresetCall, type AdminVariables } from "../admin/actor.ts";
import { credentialRefusalReason, presentedCredential } from "../admin/credential-refusal.ts";
import { CONSOLE_REQUEST_HEADER, gatewayErrorOf } from "../auth/identity.ts";
import { CATALOG, type OperationName } from "../contracts/catalog.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";

type AnalyticsEnv = { Bindings: Env; Variables: Partial<AdminVariables> };

/** The surfaces whose every request is a management call, matched or not. */
const MANAGEMENT_PATH = /^\/v2\/(?:admin|cli)(?:\/|$)/u;

export const managementAnalytics: MiddlewareHandler<AnalyticsEnv> = async (c, next) => {
  if (managementDataset(c.env) === null || isPresetCall(c.req.raw) || !MANAGEMENT_PATH.test(c.req.path)) return next();
  const started = Date.now();
  try {
    await next();
  } catch (error) {
    await record(c, started, refusalOf(gatewayErrorOf(error)));
    throw error;
  }
  await record(c, started, endingOf(c.res.status));
};

/** Writes the call's data point. Anything that fails here is logged and never changes the call's answer. */
async function record(c: Context<AnalyticsEnv>, started: number, ending: CallEnding): Promise<void> {
  try {
    const operation = catalogOperation(c.req.method, c.req.path);
    const tool = operation === "callCliTool" ? await registeredTool(c.req.path) : null;
    const actor = c.get("actor");
    const header = (name: string) => c.req.header(name);
    const credential = actor?.credentialType ?? presentedCredential(header);
    const agent = userAgentOf(c.req.header("user-agent"));
    recordManagementCall(c.env, {
      accountId: actor?.accountId ?? null,
      channel: httpChannel(credential, c.req.header(CONSOLE_REQUEST_HEADER) === "1", agent.isCli),
      credential,
      identity: actor === undefined ? null : "human",
      operation,
      tool,
      outcome: ending.outcome,
      status: ending.status,
      code: ending.code,
      reason: ending.reason ?? (ending.code === "auth_required" ? credentialRefusalReason(header) : null),
      field: ending.field,
      issue: ending.issue,
      client: agent.client,
      clientVersion: agent.version,
      requestId: c.req.header("cf-ray"),
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log("warn", "management_analytics_write_failed", { error: errorFacts(error) });
  }
}

/**
 * The tool a CLI tool call names, as the tool table spells it, or null for a
 * name that is not a tool: never the path's own text, which the caller chose.
 * The table is loaded only here, for a CLI tool call, as the call itself does.
 */
async function registeredTool(path: string): Promise<string | null> {
  let name: string;
  try {
    name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return null;
  }
  const { MCP_TOOLS } = await import("../mcp/tools.ts");
  return MCP_TOOLS.find((tool) => tool.name === name)?.name ?? null;
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
 * The console for a person's session or the console's own request; the CLI
 * for a client naming itself `agw` first, which only the CLI does; the API for
 * everything else. A label for analytics, never a decision.
 */
function httpChannel(credential: ManagementCredential, consoleRequest: boolean, isCli: boolean): ManagementChannel {
  if (credential === "session" || consoleRequest) return "console";
  return isCli ? "cli" : "api";
}
