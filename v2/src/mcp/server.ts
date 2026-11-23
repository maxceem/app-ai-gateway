/**
 * The MCP server (v1's, ported): stateless, one fresh server per request, the
 * tools of `./tools.ts` and the guide as a resource.
 *
 * This module is the only one that names the MCP SDK, and it is reached only
 * through the lazily mounted MCP app, so neither the SDK nor its schemas are
 * evaluated on a provider request's cold start.
 */
import type { CallToolResult, McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { asGatewayAuthError, isCfAuthError } from "../auth/identity.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { asGatewayError } from "../core/platform-errors.ts";
import { MCP_GUIDE, MCP_GUIDE_URI, MCP_INSTRUCTIONS } from "./guide.ts";
import { runTool, type ToolCaller } from "./run.ts";
import { redactSecrets } from "./secret-fields.ts";
import { nextAction, toolsFor, type McpTool } from "./tools.ts";

type Sdk = typeof import("@modelcontextprotocol/server");

/** The server's version in its `initialize` answer. */
const SERVER_VERSION = "2.0.0";

/** The MCP SDK, loaded once per isolate on the first MCP request. A failed load is forgotten. */
let loaded: Promise<Sdk> | undefined;
const mcpSdk = (): Promise<Sdk> =>
  (loaded ??= import("@modelcontextprotocol/server").catch((error: unknown) => {
    loaded = undefined;
    throw error;
  }));

/**
 * Discovery is the same for everyone: the tool table and the guide do not
 * depend on who asks, so a client, and any cache between, may keep it a day.
 * Authorization is enforced when a tool runs, never by hiding one.
 */
const PUBLIC_DAY = { ttlMs: 86_400_000, cacheScope: "public" } as const;

/**
 * Serves one MCP request for one authenticated caller. 2026-07-28 requests
 * are answered as JSON; a 2025-era client is served by the SDK's stateless
 * legacy fallback, which answers `GET` and `DELETE` with `405`. The caller
 * reaches the server as the request's `authInfo`, which the SDK passes through
 * and never derives from a header.
 */
export async function serveMcp(request: Request, caller: ToolCaller): Promise<Response> {
  const mcp = await mcpHandler();
  return mcp.fetch(request, {
    authInfo: {
      // Never the credential itself: nothing here reads it.
      token: "",
      clientId: caller.actor.credentialId ?? "",
      scopes: [caller.actor.grant],
      extra: { caller, requestId: request.headers.get("cf-ray") },
    },
  });
}

type McpHttpHandler = ReturnType<Sdk["createMcpHandler"]>;

/**
 * One handler per isolate: the factory builds each request's server from the
 * caller it is handed. `maxSubscriptions: 0` refuses every
 * `subscriptions/listen` before it opens a stream, since nothing here ever
 * publishes a change. A failed build is forgotten.
 */
let handler: Promise<McpHttpHandler> | undefined;
const mcpHandler = (): Promise<McpHttpHandler> =>
  (handler ??= mcpSdk()
    .then((sdk) =>
      sdk.createMcpHandler(
        (context) => {
          const extra = context.authInfo?.extra as { caller?: ToolCaller; requestId?: string | null } | undefined;
          // `serveMcp` is the only way in, and it always passes one.
          if (!extra?.caller) throw new Error("An MCP server was built without its caller");
          return mcpServer(sdk, extra.caller, extra.requestId ?? null);
        },
        {
          legacy: "stateless",
          responseMode: "json",
          maxSubscriptions: 0,
          // Reporting only: what the SDK refused, it has already answered.
          onerror: (error) => log("warn", "mcp_request_rejected", { error: errorFacts(error) }),
        },
      ),
    )
    .catch((error: unknown) => {
      handler = undefined;
      throw error;
    }));

function mcpServer(sdk: Sdk, caller: ToolCaller, requestId: string | null): McpServer {
  const server = new sdk.McpServer(
    { name: "app-ai-gateway", version: SERVER_VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      // The table is fixed for the life of a deployment, so no change notification is offered.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      cacheHints: { "tools/list": PUBLIC_DAY, "resources/list": PUBLIC_DAY, "resources/read": PUBLIC_DAY },
    },
  );
  for (const tool of toolsFor(caller.env)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: advertised(tool.input), annotations: tool.annotations },
      (input) => callTool(tool, input, caller, requestId),
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
 * A tool's input schema as the SDK takes one, for discovery only. The
 * arguments reach the tool as they were sent: the operation judges them, in
 * the order and the words it refuses an HTTP request in.
 */
function advertised(schema: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "app-ai-gateway",
      jsonSchema: schema["~standard"].jsonSchema,
      validate: (value) => ({
        value: value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
      }),
    },
  };
}

/**
 * Runs one tool call. A refusal is an answer, not a failure of the protocol:
 * a gateway error becomes a tool result marked as an error, with its code, its
 * message and what to do next. Only the bearer gate answers with an HTTP status.
 */
async function callTool(tool: McpTool, input: Record<string, unknown>, caller: ToolCaller, requestId: string | null): Promise<CallToolResult> {
  try {
    const { result, summary } = await runTool(tool, input, caller);
    return { content: [{ type: "text", text: summary }], structuredContent: result as Record<string, unknown> };
  } catch (error) {
    const refusal = isCfAuthError(error) ? asGatewayAuthError(error) : asGatewayError(error) ?? error;
    if (refusal instanceof GatewayError) return refused(tool, refusal, requestId);
    // Answered and logged with nothing of the failure's message: a database
    // error can quote what the call sent.
    log("error", "unhandled_error", { path: "/v2/mcp", tool: tool.name, ray: requestId ?? undefined, error: errorFacts(error) });
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

/** A refusal as a tool result, logged by its code and the tool alone, never an argument. */
function refused(tool: McpTool, error: GatewayError, requestId: string | null): CallToolResult {
  log(error.status >= 500 ? "error" : "warn", "gateway_error", {
    code: error.code,
    status: error.status,
    path: "/v2/mcp",
    tool: tool.name,
    ray: requestId ?? undefined,
  });
  const next = tool.next?.[error.code] ?? nextAction(error.code);
  const message = error.message.replace(/[.\s]+$/u, "");
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code}: ${message}. ${next}` }],
    structuredContent: {
      error: error.code,
      message: error.message,
      status: error.status,
      next,
      ...(error.data === undefined ? {} : { data: redactSecrets(error.data) }),
    },
  };
}
