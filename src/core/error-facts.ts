import { KmsClientError } from "@maxceem/cf-kms/client";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm";
import { ZodError } from "zod";
import {
  SECRET_VAULT_PROBLEMS,
  SECRET_VAULT_SETTINGS,
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  type SecretVaultProblem,
  type SecretVaultSetting,
} from "../vault/types";
import { GatewayError, type ErrorCode, type GatewayErrorReason } from "./errors";
import {
  recognisedFailure,
  type KnownPlatformMessage,
  type PlatformFailureReason,
} from "./platform-errors";

/**
 * The error classes a log line names. An error of any other class is logged as
 * `other`: a class name is a string too, and only names this list spells are
 * written.
 */
type ErrorClass =
  | "GatewayError"
  | "SecretVaultConfigurationError"
  | "SecretVaultBlobError"
  | "KmsClientError"
  | "DrizzleQueryError"
  | "DrizzleError"
  | "ZodError"
  | "DOMException"
  | "AggregateError"
  | "TypeError"
  | "RangeError"
  | "SyntaxError"
  | "ReferenceError"
  | "URIError"
  | "EvalError"
  | "Error"
  | "other"
  | "not_an_error";

/** Most specific first: `instanceof` matches a subclass's ancestors as well. */
const ERROR_CLASSES: readonly (readonly [new (...args: never[]) => Error, ErrorClass])[] = [
  [GatewayError, "GatewayError"],
  [SecretVaultConfigurationError, "SecretVaultConfigurationError"],
  [SecretVaultBlobError, "SecretVaultBlobError"],
  [KmsClientError, "KmsClientError"],
  [DrizzleQueryError, "DrizzleQueryError"],
  [DrizzleError, "DrizzleError"],
  [ZodError, "ZodError"],
  [AggregateError, "AggregateError"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [URIError, "URIError"],
  [EvalError, "EvalError"],
];

/**
 * The `DOMException` names worth telling apart — an abort or timeout from a
 * network failure. Any other is logged without a name.
 */
const DOM_EXCEPTION_NAMES = [
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "DataError",
  "OperationError",
  "InvalidStateError",
  "InvalidAccessError",
  "NotSupportedError",
  "QuotaExceededError",
  "SyntaxError",
] as const;

/**
 * The cf-kms client's own codes. It also passes on whatever code the KMS
 * service answered with, which is text from the network: any other is logged
 * as `unrecognised`.
 */
const KMS_CODES = [
  "invalid_envelope",
  "insecure_url",
  "invalid_response",
  "request_failed",
  "decrypt_failed",
  "unauthorized",
] as const;

/**
 * Every gateway refusal code, so a logged one is chosen from a list like every
 * other string here. The check below fails to compile when `ErrorCode` gains
 * a code this list lacks.
 */
const ERROR_CODES = [
  "auth_required",
  "forbidden",
  "session_required",
  "grant_insufficient",
  "account_exists",
  "registration_disabled",
  "no_eligible_organization",
  "operation_expired",
  "operation_denied",
  "operation_pending",
  "already_completed",
  "operation_not_found",
  "operation_mismatch",
  "already_revealed",
  "validation_error",
  "rate_limited",
  "conflict",
  "not_found",
  "not_a_member",
  "last_owner",
  "unclaimed_access_expired",
  "account_expired",
  "email_unverified",
  "billing_payment_required",
  "billing_unavailable",
  "billing_not_found",
  "billing_action_forbidden",
  "billing_conflict",
  "attest_failed",
  "assertion_required",
  "issuer_token_rejected",
  "issuer_claims_missing",
  "issuer_verification_unavailable",
  "auth_method_not_supported",
  "billing_request_quota_exceeded",
  "billing_plan_limit_reached",
  "app_rate_limited",
  "app_budget_exhausted",
  "pricing_not_configured",
  "model_not_allowed",
  "path_not_allowed",
  "api_style_not_supported",
  "max_output_tokens_exceeded",
  "payload_too_large",
  "provider_error",
  "provider_not_configured",
  "provider_disabled",
  "provider_unavailable",
  "provider_not_found",
  "slug_taken",
  "provider_not_supported_by_gateway",
  "provider_gateway_managed",
  "gateway_in_use",
  "provider_key_invalid",
  "invalid_request",
  "app_not_found",
  "app_revision_required",
  "app_revision_conflict",
  "app_disabled",
  "endpoint_not_found",
  "unsupported_snippet",
  "email_unavailable",
  "service_unavailable",
  "internal_error",
] as const satisfies readonly ErrorCode[];
type UnlistedErrorCode = Exclude<ErrorCode, (typeof ERROR_CODES)[number]>;
const everyErrorCodeListed: [UnlistedErrorCode] extends [never] ? true : never = true;
void everyErrorCodeListed;

/** Every refusal reason, checked against `GatewayErrorReason` like the codes above. */
const ERROR_REASONS = [
  "jwks_unreachable",
  "jwks_invalid",
  "header_invalid",
  "unknown_kid",
  "alg_mismatch",
  "bad_signature",
  "issuer_mismatch",
  "audience_mismatch",
  "timestamps_invalid",
  "expired",
  "lifetime_exceeded",
  "claims_missing",
  "user_id_missing",
  "platform_unavailable",
  "platform_overloaded",
  "deadline_exceeded",
] as const satisfies readonly GatewayErrorReason[];
type UnlistedErrorReason = Exclude<GatewayErrorReason, (typeof ERROR_REASONS)[number]>;
const everyErrorReasonListed: [UnlistedErrorReason] extends [never] ? true : never = true;
void everyErrorReasonListed;

/**
 * What a log line may say about a refusal: its code and reason, each chosen
 * from its list. A refusal's message is not among them: it may quote input.
 */
export function refusalFacts(error: GatewayError): { code?: ErrorCode; reason?: GatewayErrorReason } {
  const code = ERROR_CODES.find((known) => known === error.code);
  const reason = ERROR_REASONS.find((known) => known === error.reason);
  return {
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
  };
}

const MAX_CAUSE_DEPTH = 4;

/**
 * What a log line says about an error. Every field is a constant this
 * codebase spells or a boolean, so no text an error carries — its message, its
 * stack, a query, a value bound to one, a header, a URL — can reach a log
 * through it.
 */
export interface ErrorFacts {
  class: ErrorClass;
  /** A gateway refusal's code. */
  code?: ErrorCode;
  /** Which `DOMException` it was, where the name is one of the list above. */
  domException?: (typeof DOM_EXCEPTION_NAMES)[number];
  /** The platform failure it was recognised as, and the documented message that recognised it. */
  platform?: Exclude<PlatformFailureReason, "deadline_exceeded">;
  platformMessage?: KnownPlatformMessage;
  /** Which vault setting a configuration error is about, and what is wrong with it. */
  vault?: { setting?: SecretVaultSetting; problem?: SecretVaultProblem; kekVersion?: number };
  /** A cf-kms failure's code and the HTTP status it came with. */
  kms?: { code: (typeof KMS_CODES)[number] | "unrecognised"; status?: number };
  /** Cloudflare's own flags, copied only where they are booleans. */
  retryable?: boolean;
  overloaded?: boolean;
  remote?: boolean;
  cause?: ErrorFacts;
}

function errorClass(error: Error): ErrorClass {
  if (error instanceof DOMException) return "DOMException";
  for (const [type, name] of ERROR_CLASSES) {
    if (error instanceof type) return name;
  }
  return Object.getPrototypeOf(error) === Error.prototype ? "Error" : "other";
}

/** `value` where it is a whole number, and nothing otherwise. */
function wholeNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

/** `true` or `false` where `value` is that boolean, and nothing otherwise. */
function flag(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

/**
 * The facts about `error` that are safe to log, and the only description of
 * an error a log line may carry.
 */
export function errorFacts(error: unknown, depth = 0): ErrorFacts {
  if (!(error instanceof Error)) return { class: "not_an_error" };
  const flags = error as { retryable?: unknown; overloaded?: unknown; remote?: unknown };
  const recognised = recognisedFailure(error);
  const domException = error instanceof DOMException
    ? DOM_EXCEPTION_NAMES.find((name) => name === error.name)
    : undefined;
  const facts: ErrorFacts = { class: errorClass(error) };
  if (error instanceof GatewayError) {
    const { code } = refusalFacts(error);
    if (code !== undefined) facts.code = code;
  }
  if (error instanceof SecretVaultConfigurationError) {
    // Chosen from the lists rather than copied, as every string here is.
    const setting = SECRET_VAULT_SETTINGS.find((known) => known === error.setting);
    const problem = SECRET_VAULT_PROBLEMS.find((known) => known === error.problem);
    const kekVersion = wholeNumber(error.kekVersion);
    facts.vault = {
      ...(setting === undefined ? {} : { setting }),
      ...(problem === undefined ? {} : { problem }),
      ...(kekVersion === undefined ? {} : { kekVersion }),
    };
  }
  if (error instanceof KmsClientError) {
    const status = wholeNumber(error.status);
    facts.kms = {
      code: KMS_CODES.find((known) => known === error.code) ?? "unrecognised",
      ...(status === undefined ? {} : { status }),
    };
  }
  if (domException !== undefined) facts.domException = domException;
  if (recognised !== null) {
    facts.platform = recognised.reason;
    if (recognised.message !== undefined) facts.platformMessage = recognised.message;
  }
  const retryable = flag(flags.retryable);
  const overloaded = flag(flags.overloaded);
  const remote = flag(flags.remote);
  if (retryable !== undefined) facts.retryable = retryable;
  if (overloaded !== undefined) facts.overloaded = overloaded;
  if (remote !== undefined) facts.remote = remote;
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) facts.cause = errorFacts(error.cause, depth + 1);
  return facts;
}
