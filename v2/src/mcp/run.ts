/**
 * One tool call, whichever surface carried it: the MCP endpoint, or the
 * CLI's `POST /v2/cli/tools/{tool}`. Both answer with exactly this, so an
 * agent and a terminal get the same result and the same summary of it.
 *
 * A tool's operation runs as a request to the management API made inside the
 * Worker, carrying the caller this surface has already authenticated (see
 * `asCaller`). So it goes through the operation's own handler: the same
 * policy, checks, errors and answer as over HTTP.
 *
 * A refusal is thrown, as a `GatewayError`, for the surface to answer in its
 * own way.
 */
import type { ExecutionContext as HonoExecutionContext } from "hono";
import { asCaller, type PresetCaller } from "../admin/actor.ts";
import { CATALOG } from "../contracts/catalog.ts";
import { GatewayError, type ErrorCode, type GatewayErrorData } from "../core/errors.ts";
import { REDACTED, redactSecrets, secretField } from "./secret-fields.ts";
import { pathParameterNames, type McpTool, type ToolRequest } from "./tools.ts";

/** Who calls a tool, and where the Worker is running it. */
export interface ToolCaller extends PresetCaller {
  readonly env: Env;
  /** The origin of the request that carried the call, for the operation's own request. */
  readonly origin: string;
  readonly executionCtx?: HonoExecutionContext;
}

export async function runTool(
  tool: McpTool,
  input: Record<string, unknown>,
  caller: ToolCaller,
): Promise<{ result: unknown; summary: string }> {
  refuseArguments(tool, input);
  tool.check?.(input);
  const before = tool.before?.(input) ?? null;
  const retryAfter = before === null ? null : (tool.retryAfter?.(input) ?? null);
  let body: unknown;
  for (let attempt = 0; ; attempt++) {
    // What is stored now, for a request that depends on it; read again if the write finds it changed meanwhile.
    const read = before === null ? undefined : await callOperation(before, caller);
    try {
      body = await callOperation(tool.request(input, read), caller);
      break;
    } catch (error) {
      if (attempt === 0 && retryAfter !== null && error instanceof GatewayError && error.code === retryAfter) continue;
      throw error;
    }
  }
  const hidden: string[] = [];
  const result = redactSecrets(tool.result ? tool.result(body, input) : body, tool.keyMetadataAt ?? [], [], hidden);
  const summary = tool.summary(result, input);
  return { result, summary: hidden.length === 0 ? summary : `${summary} ${hiddenNote(hidden)}` };
}

/**
 * Refuses, before anything reads them: an argument the tool does not take,
 * and a field named like a credential anywhere in the arguments. A key is
 * entered by a person, never handed to a tool: one that reached a tool has
 * already been seen by the agent. The refusal names the field, never its value.
 */
function refuseArguments(tool: McpTool, input: Record<string, unknown>): void {
  const secret = secretField(input);
  if (secret !== null) {
    throw new GatewayError(
      400,
      "invalid_request",
      `${secret}: a credential is never a tool argument; a person enters keys in the console or with agw`,
    );
  }
  const unknown = Object.keys(input).find((key) => !Object.hasOwn(tool.input.shape, key));
  if (unknown !== undefined) {
    throw new GatewayError(400, "invalid_request", `${unknown}: not an argument of ${tool.name}; nothing ran`);
  }
}

/** What a reader is told when a result hides values, so an agent does not send `[redacted]` back as the stored value. */
export function hiddenNote(hidden: readonly string[]): string {
  const shown = hidden.slice(0, 3).join(", ");
  const more = hidden.length > 3 ? ` and ${hidden.length - 3} more` : "";
  const one = hidden.length === 1;
  return `${one ? "A value" : `${hidden.length} values`} named like a credential ${one ? "is" : "are"} shown as ${REDACTED} (${shown}${more}): no tool ever returns one.`;
}

/** Runs one operation as the caller, and answers its JSON body or throws its refusal. */
async function callOperation(request: ToolRequest, caller: ToolCaller): Promise<unknown> {
  const spec = CATALOG[request.operation];
  let path: string = spec.path;
  for (const name of pathParameterNames(spec.path)) {
    const value = request.params?.[name];
    if (value === undefined || value === "") {
      throw new GatewayError(400, "invalid_request", `${name}: required`);
    }
    // `encodeURIComponent` leaves these as they are, and a URL folds them
    // into another path, so the call would reach another operation.
    if (value === "." || value === "..") {
      throw new GatewayError(400, "invalid_request", `${name}: not a valid id`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  const url = new URL(path, caller.origin);
  for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
  const hasBody = request.body !== undefined;
  const operationRequest = asCaller(
    new Request(url, {
      method: spec.method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
    }),
    caller,
  );
  const { default: management } = await import("../management/app.ts");
  // A refusal comes out of `fetch` as the thrown `GatewayError` itself.
  const response = await management.fetch(operationRequest, caller.env, caller.executionCtx);
  const answer = await response.json<Record<string, unknown>>();
  if (!response.ok) {
    const error = (answer.error ?? {}) as { code?: string; message?: string; data?: GatewayErrorData };
    throw new GatewayError(
      response.status,
      (error.code ?? "invalid_request") as ErrorCode,
      error.message ?? "The operation refused the call",
      undefined,
      error.data === undefined ? {} : { data: error.data },
    );
  }
  return answer;
}
