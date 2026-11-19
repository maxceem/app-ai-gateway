/**
 * Errors the gateway answers with on purpose.
 *
 * A `GatewayError` becomes the JSON error body declared in the catalog:
 * `{ error: { code, message } }`, with its status and any headers. Codes are
 * stable, so clients and smoke checks can rely on them; they keep v1's names
 * where the behaviour is the same.
 */
import type { IssuerRejectionReason } from "../client-auth/issuer.ts";
import type { PlatformFailureReason } from "./platform-errors.ts";

export type ErrorCode =
  | "auth_required"
  | "assertion_required"
  | "attest_failed"
  | "auth_method_not_supported"
  | "issuer_token_rejected"
  | "issuer_claims_missing"
  | "issuer_verification_unavailable"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "app_not_found"
  | "app_disabled"
  | "not_found"
  | "service_unavailable"
  | "internal_error";

export type GatewayErrorData = Record<string, string | number | boolean>;

/** Why a refusal happened, for logs and auth events. Never sent to the client. */
export type GatewayErrorReason = IssuerRejectionReason | PlatformFailureReason;

export interface GatewayErrorDetails {
  reason?: GatewayErrorReason;
  /** The end user a refusal knew, such as an issuer token missing an entitlement claim. */
  userId?: string;
  data?: GatewayErrorData;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly reason?: GatewayErrorReason;
  readonly userId?: string;
  readonly data?: GatewayErrorData;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: HeadersInit,
    details: GatewayErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "GatewayError";
    this.reason = details.reason;
    this.userId = details.userId;
    this.data = details.data;
  }
}
