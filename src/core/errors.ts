export type ErrorCode =
  | "auth_required"
  | "forbidden"
  | "session_required"
  | "registration_disabled"
  | "validation_error"
  | "conflict"
  | "not_found"
  | "not_a_member"
  | "last_owner"
  | "attest_failed"
  | "issuer_token_rejected"
  | "auth_method_not_supported"
  | "rate_limited"
  | "budget_exhausted"
  | "pricing_not_configured"
  | "model_not_allowed"
  | "path_not_allowed"
  | "max_output_tokens_exceeded"
  | "payload_too_large"
  | "provider_error"
  | "invalid_request"
  | "app_not_found"
  | "app_disabled"
  | "endpoint_not_found"
  | "internal_error";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}
