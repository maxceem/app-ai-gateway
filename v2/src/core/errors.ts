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
  | "internal_error"
  // The provider request path (v1's codes).
  | "provider_not_configured"
  | "provider_disabled"
  | "provider_unavailable"
  | "provider_error"
  | "path_not_allowed"
  | "model_not_allowed"
  | "pricing_not_configured"
  | "max_output_tokens_exceeded"
  | "preset_not_found"
  | "job_not_found"
  | "app_rate_limited"
  | "app_budget_exhausted"
  | "billing_request_quota_exceeded"
  | "billing_payment_required"
  | "billing_unavailable"
  // The management API (v1's codes).
  | "forbidden"
  | "grant_insufficient"
  | "conflict"
  | "app_revision_required"
  | "app_revision_conflict"
  | "account_forbidden"
  | "provider_not_found"
  | "key_not_found"
  | "billing_plan_limit_reached"
  | "billing_feature_not_included"
  | "billing_not_found"
  | "billing_action_forbidden"
  | "billing_conflict"
  | "subscription_changed"
  | "price_changed"
  // Sign-in and accounts (v1's codes).
  | "session_required"
  | "not_a_member"
  | "last_owner"
  | "operation_expired"
  | "operation_denied"
  | "operation_not_found"
  | "operation_mismatch"
  | "already_revealed"
  | "already_completed"
  | "no_eligible_organization"
  | "registration_disabled"
  | "email_unverified"
  | "email_unavailable"
  // MCP tools and the CLI's tool catalog (v1's codes).
  | "tool_not_found"
  | "tool_changed";

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
