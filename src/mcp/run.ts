import { runOperation, type OperationCaller, type OperationRequest } from "../management/executor";
import { OPERATION_HANDLERS } from "../management/handlers";
import { redactSecrets } from "./secret-fields";
import type { McpTool, ToolOperation } from "./tools";

/**
 * One tool call, whichever transport carried it: the MCP endpoint, or the
 * CLI's `POST /v1/cli/tools/{tool}`. Both answer with exactly this, so an
 * agent and a terminal get the same result and the same summary of it.
 *
 * The result is redacted before the summary is written from it: what a tool
 * answers may have been stored by any transport, and an app document stored
 * through the API may hold provider-native parameters of any name. A refusal
 * is thrown, as the `GatewayError` the operation raised, for the transport to
 * answer in its own way.
 */
export async function runTool(
  tool: McpTool,
  input: Record<string, unknown>,
  caller: OperationCaller,
): Promise<{ result: unknown; summary: string }> {
  const body = tool.perform ? await tool.perform(input, caller) : await callOperation(tool, input, caller);
  const result = redactSecrets(tool.result ? tool.result(body, input) : body, tool.keyMetadataAt);
  return { result, summary: tool.summary(result, redactSecrets(input)) };
}

function callOperation(tool: McpTool, input: Record<string, unknown>, caller: OperationCaller): Promise<unknown> {
  if (!tool.call) throw new Error(`MCP tool ${tool.name} has neither an operation nor a perform`);
  const { operation, request, before } = tool.call(input);
  return runToolOperation(operation, request as never, caller, before);
}

/** One operation, run with its own registered handler and the tool's own check. */
export function runToolOperation<K extends ToolOperation>(
  operation: K,
  request: OperationRequest<K>,
  caller: OperationCaller,
  before?: () => void,
): Promise<unknown> {
  return runOperation(operation, caller, request, OPERATION_HANDLERS[operation], before ? { before } : {});
}
