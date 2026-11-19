/**
 * An HTTP-level refusal of an MCP request, in the shape an MCP client reads:
 * a JSON-RPC error with no request id, since the request was never read far
 * enough to have one. Used for the few answers that are the endpoint's rather
 * than the protocol's — a missing credential, a browser origin that may not
 * call — and never for a business refusal, which is a tool result.
 */
export function jsonRpcRefusal(status: number, message: string, headers: HeadersInit = {}): Response {
  const response = Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status },
  );
  new Headers(headers).forEach((value, name) => response.headers.set(name, value));
  return response;
}
