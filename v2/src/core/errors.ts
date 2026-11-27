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
  // A live session over the user's or the app's session limit (D15).
  | "session_limit"
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
  | "billing_outcome_unknown"
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
  | "support_plan_required"
  | "sender_changed"
  // MCP tools and the CLI's tool catalog (v1's codes).
  | "tool_not_found"
  | "tool_changed"
  // An ElevenLabs agent can't be read when an app lists it on an account with split keys on (11a).
  | "split_keys_unsupported";

export type GatewayErrorData = Record<string, string | number | boolean>;

/** Why a refusal happened, for logs and auth events. Never sent to the client. */
export type GatewayErrorReason = IssuerRejectionReason | PlatformFailureReason;

export interface GatewayErrorDetails {
  reason?: GatewayErrorReason;
  /** The end user a refusal knew, such as an issuer token missing an entitlement claim. */
  userId?: string;
  data?: GatewayErrorData;
  /**
   * The top-level request field a validation refusal names, and the schema's
   * issue code for it, such as `invalid_type`. Never its value. Read only by
   * management analytics (`src/analytics/management.ts`).
   */
  field?: { name: string; issue: string };
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers?: HeadersInit;
  readonly reason?: GatewayErrorReason;
  readonly userId?: string;
  readonly data?: GatewayErrorData;
  readonly field?: { name: string; issue: string };

  // Fields assigned by hand rather than as parameter properties, so Node can
  // load this module with type stripping alone (the operator scripts do).
  constructor(status: number, code: ErrorCode, message: string, headers?: HeadersInit, details: GatewayErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.name = "GatewayError";
    this.reason = details.reason;
    this.userId = details.userId;
    this.data = details.data;
    this.field = details.field;
  }

  /** The same refusal with other headers: every other detail is copied, so none is lost on the way. */
  withHeaders(headers: HeadersInit): GatewayError {
    return new GatewayError(this.status, this.code, this.message, headers, {
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      ...(this.data === undefined ? {} : { data: this.data }),
      ...(this.field === undefined ? {} : { field: this.field }),
      ...(this.cause === undefined ? {} : { cause: this.cause }),
    });
  }
}

/**
 * Names the code of an error the gateway answers itself, so a client can
 * tell it from a provider's own without reading the body: an app that
 * streams its answers would spend the body reading it. Never on a provider's
 * answer, which keeps its own headers and has any of this name removed
 * (`clientResponseHeaders`).
 */
export const ERROR_CODE_HEADER = "x-agw-error";
