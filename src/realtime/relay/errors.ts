import type { ErrorCode } from "../../core/errors";

/**
 * A refusal the realtime Worker answers with: the gateway's error shape, kept
 * here so the realtime Worker runs none of the gateway's code. Its codes are
 * the gateway's, checked when both compile.
 */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: Record<string, string>,
    readonly data?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/** The gateway's JSON error body, for a refused handshake. */
export function errorResponse(error: RelayError): Response {
  const body = { error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } };
  return new Response(JSON.stringify(body), {
    status: error.status,
    headers: { "content-type": "application/json; charset=UTF-8", ...error.headers },
  });
}
