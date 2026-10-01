import type { CallToolResult, McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { asGatewayAuthError, isCfAuthError } from "../auth/identity";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { SERVER_VERSION } from "../core/version";
import {
  runOperation,
  type OperationCaller,
  type OperationRequest,
} from "../management/executor";
import { OPERATION_HANDLERS } from "../management/handlers";
import { MCP_GUIDE, MCP_GUIDE_URI, MCP_INSTRUCTIONS } from "./guide";
import { MCP_TOOLS, nextAction, type McpTool, type ReadOperation } from "./tools";

type Sdk = typeof import("@modelcontextprotocol/server");

/**
 * The MCP SDK, loaded on the first MCP request and shared by every one after
 * it in the isolate — the same deferral `cfAuth()` gives the identity library.
 *
 * This module is the only one that names the SDK, and it is itself reached only
 * through the lazily mounted MCP app, so neither the SDK nor the zod protocol
 * schemas it builds on evaluate on a proxied request's cold start. A rejection
 * is forgotten rather than pinned, for the reason `cfAuth()` forgets one.
 */
const mcpSdk = (): Promise<Sdk> => (loaded ??= import("@modelcontextprotocol/server").catch(forget));

let loaded: Promise<Sdk> | undefined;

function forget(error: unknown): never {
  loaded = undefined;
  throw error;
}

/**
 * Discovery is the same for everyone — the tool table and the guide do not
 * depend on who asks — so a client, and any cache between, may keep it a day.
 * Authorization is enforced when a tool runs, never by hiding one.
 */
const PUBLIC_DAY = { ttlMs: 86_400_000, cacheScope: "public" } as const;

/**
 * Serves one MCP request for one authenticated caller.
 *
 * Stateless by construction: a fresh server per request, no session, nothing a
 * later request could find. 2026-07-28 requests are answered as JSON; a
 * 2025-era client is served by the SDK's stateless legacy fallback from the
 * same factory, which also answers `GET` and `DELETE` — the old session
 * operations — with `405`.
 *
 * The caller reaches the factory as the request's `authInfo`, which the SDK
 * passes through untouched and never derives from a header.
 */
export async function serveMcp(request: Request, caller: OperationCaller): Promise<Response> {
  const mcp = await mcpHandler();
  return mcp.fetch(request, {
    authInfo: {
      // Never the credential itself: nothing reads this but the SDK's own
      // bearer helpers, which this endpoint does not use.
      token: "",
      clientId: caller.auth?.actor.credentialId ?? "",
      scopes: caller.auth ? [caller.auth.actor.grant] : [],
      extra: { caller },
    },
  });
}

type McpHttpHandler = ReturnType<Sdk["createMcpHandler"]>;

/**
 * One handler per isolate, since nothing in it belongs to a request: the
 * factory builds each request's server from the caller it is handed.
 *
 * No event bus is supplied, and `maxSubscriptions: 0` refuses every
 * `subscriptions/listen` in-band before it opens a stream: nothing here ever
 * publishes a change, so a stream held open would only hold the Worker. A
 * failed build is forgotten, as a failed SDK load is.
 */
const mcpHandler = (): Promise<McpHttpHandler> =>
  (handler ??= mcpSdk().then((sdk) =>
    sdk.createMcpHandler((context) => mcpServer(sdk, callerOf(context.authInfo?.extra)), {
      legacy: "stateless",
      responseMode: "json",
      maxSubscriptions: 0,
      // Reporting only: what the SDK refused, it has already answered.
      onerror: (error) => log("warn", "mcp_request_rejected", { error: error.message }),
    })).catch((error: unknown) => {
      handler = undefined;
      throw error;
    }));

let handler: Promise<McpHttpHandler> | undefined;

function callerOf(extra: Record<string, unknown> | undefined): OperationCaller {
  const caller = extra?.caller as OperationCaller | undefined;
  // `serveMcp` is the only way in, and it always passes one.
  if (!caller) throw new Error("An MCP server was built without its caller");
  return caller;
}

function mcpServer(sdk: Sdk, caller: OperationCaller): McpServer {
  const server = new sdk.McpServer(
    { name: "app-ai-gateway", version: SERVER_VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      // The table is fixed for the life of a deployment and nothing publishes
      // a change to it, so no change notification is offered.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      cacheHints: {
        "tools/list": PUBLIC_DAY,
        "resources/list": PUBLIC_DAY,
        "resources/read": PUBLIC_DAY,
      },
    },
  );
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: advertised(tool.input),
        annotations: tool.annotations,
      },
      (input) => callTool(tool, input, caller),
    );
  }
  server.registerResource(
    "guide",
    MCP_GUIDE_URI,
    {
      title: "How to work with this gateway over MCP",
      description: "The rules, the tools and the workflows, in full. Read it before changing anything.",
      mimeType: "text/markdown",
      cacheHint: PUBLIC_DAY,
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: MCP_GUIDE }] }),
  );
  return server;
}

/**
 * A tool's input schema as the SDK takes one, for discovery only.
 *
 * The SDK publishes `~standard.jsonSchema` in `tools/list` and runs
 * `~standard.validate` on every call's arguments before the tool does. The
 * first is the zod schema's own; the second hands the arguments over as they
 * were sent. Judging them is the executor's, after it has found the
 * application and applied the policy — the order an HTTP request is refused
 * in — and in the words `schemaIssueMessage` gives every refusal, with the
 * structured result an agent reads. Were the SDK to judge them first, a call
 * naming another account's app with a bad argument would be told about the
 * argument, in the SDK's words and with nothing structured.
 */
function advertised(schema: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "app-ai-gateway",
      jsonSchema: schema["~standard"].jsonSchema,
      // The protocol already requires `arguments` to be an object; anything
      // else is the empty one, which the operation then refuses as it would.
      validate: (value) => ({
        value: value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
      }),
    },
  };
}

/**
 * Runs one tool call as its catalog operation.
 *
 * The arguments arrive as the client sent them. The executor parses them with
 * the operation's own schemas, exactly as it parses a request from the API,
 * after it has resolved the application and applied the operation's policy to
 * the caller; an argument no operation schema covers is checked by the tool's
 * `before`, at the same point. The callback itself parses nothing.
 *
 * A refusal is an answer, not a failure of the protocol: a gateway error
 * becomes a tool result marked as an error, carrying its code, its message and
 * what to do next. Only the bearer gate answers with an HTTP status.
 */
async function callTool(
  tool: McpTool,
  input: Record<string, unknown>,
  caller: OperationCaller,
): Promise<CallToolResult> {
  try {
    const { operation, request, before } = tool.call(input);
    const body = await run(operation, request as never, caller, before);
    const result = tool.result ? tool.result(body, input) : body;
    return {
      content: [{ type: "text", text: tool.summary(result, input) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    const refusal = isCfAuthError(error) ? asGatewayAuthError(error) : error;
    if (refusal instanceof GatewayError) return refused(tool, input, caller, refusal);
    // Logged as the entry module logs a failure it did not expect, and
    // answered with nothing of it: no message, no stack.
    log("error", "unhandled_error", {
      path: "/mcp",
      method: "POST",
      tool: tool.name,
      source: actionSource(caller),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      isError: true,
      content: [{ type: "text", text: "internal_error: The gateway failed to answer this call. Try again later." }],
      structuredContent: {
        error: "internal_error",
        message: "Internal server error",
        status: 500,
        next: "Try again later; the failure was the gateway's, not the call's.",
      },
    };
  }
}

/** One operation, run with its own registered handler and the tool's own check. */
function run<K extends ReadOperation>(
  operation: K,
  request: OperationRequest<K>,
  caller: OperationCaller,
  before: (() => void) | undefined,
): Promise<unknown> {
  return runOperation(operation, caller, request, OPERATION_HANDLERS[operation], before ? { before } : {});
}

/**
 * Where the call came from, as cf-auth resolved the credential: `mcp`, which
 * the bearer gate asked for because this is the MCP endpoint. Read from the
 * state rather than written here, so a log line says what the authorization
 * actually carried.
 */
function actionSource(caller: OperationCaller): string | undefined {
  return caller.auth?.state.source ?? undefined;
}

/**
 * A business refusal as a tool result, logged exactly as the entry module logs
 * one it answers over HTTP — code, status and where, never a body — plus the
 * tool, and the credential's action source.
 */
function refused(
  tool: McpTool,
  input: Record<string, unknown>,
  caller: OperationCaller,
  error: GatewayError,
): CallToolResult {
  log(error.status >= 500 ? "error" : "warn", "gateway_error", {
    code: error.code,
    reason: error.reason,
    status: error.status,
    path: "/mcp",
    method: "POST",
    tool: tool.name,
    app: typeof input.app === "string" ? input.app : undefined,
    source: actionSource(caller),
  });
  const next = nextAction(error.code);
  const message = error.message.replace(/[.\s]+$/u, "");
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code}: ${message}. ${next}` }],
    structuredContent: {
      error: error.code,
      message: error.message,
      status: error.status,
      next,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}
