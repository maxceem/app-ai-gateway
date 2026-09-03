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
  | "payment_required"
  | "billing_unavailable"
  | "billing_not_found"
  | "billing_action_forbidden"
  | "billing_conflict"
  | "attest_failed"
  | "issuer_token_rejected"
  /**
   * The issuer token verified, but the app's `required_claims` are not all
   * present yet — the entitlement is still propagating from whatever writes it.
   * Its own code because the client's correct action differs: wait and retry,
   * rather than re-authenticate.
   */
  | "issuer_claims_missing"
  /**
   * The gateway could not reach or read the issuer's JWKS, so no verdict on the
   * token was ever reached. Not the caller's fault, hence 5xx and a retry.
   */
  | "issuer_verification_unavailable"
  | "auth_method_not_supported"
  /**
   * The organization used up its plan's calendar-month request allowance. The
   * gateway's only quota, and the only 429 it raises; the accompanying `data`
   * carries the allowance, the count, and when a fresh month begins.
   */
  | "monthly_request_quota_exceeded"
  | "pricing_not_configured"
  | "model_not_allowed"
  | "path_not_allowed"
  | "api_style_not_supported"
  | "max_output_tokens_exceeded"
  | "payload_too_large"
  | "provider_error"
  | "provider_not_configured"
  | "provider_disabled"
  | "provider_unavailable"
  | "slug_taken"
  | "provider_not_supported_by_gateway"
  | "provider_gateway_managed"
  | "gateway_in_use"
  | "provider_key_invalid"
  | "invalid_request"
  | "app_not_found"
  | "app_disabled"
  | "endpoint_not_found"
  | "internal_error";

/**
 * Machine-readable facts a client can act on, serialized beside the code as
 * `error.data`. Used where the code alone leaves a client with no way to decide
 * what to do next — a quota rejection, which is worth retrying only after a
 * stated instant.
 */
export type GatewayErrorData = Record<string, string | number | boolean>;

/**
 * What a rejection knows about itself beyond the wire contract. `reason` and
 * `userId` are never serialized: they are for the operator's logs and the auth
 * event log. `data` is, and is part of the public contract.
 */
export interface GatewayErrorDetails {
  /**
   * The granular cause behind a behaviour-class code — `claims_missing`,
   * `bad_signature`, `jwks_unreachable`, and so on. Deliberately a free string:
   * the vocabulary grows without any client having to learn a new code.
   */
  reason?: string;
  /**
   * The end-user identity the verification had already established when it
   * failed. Only set where the signature was checked first, so it is a verified
   * claim rather than an assertion the caller made about itself.
   */
  userId?: string;
  /** Serialized into the response body as `error.data`. */
  data?: GatewayErrorData;
}

export class GatewayError extends Error {
  readonly reason?: string;
  readonly userId?: string;
  readonly data?: GatewayErrorData;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: HeadersInit,
    details: GatewayErrorDetails = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.reason = details.reason;
    this.userId = details.userId;
    this.data = details.data;
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
