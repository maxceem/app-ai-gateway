/**
 * Bodies of the app authentication routes (`/v2/apps/{app}/auth/*` and
 * `/v2/apps/{app}/me`). The field names are v1's, so the Swift SDK only
 * changes its path prefix.
 */
import { z } from "zod";
import { APP_ATTEST_VERIFY_ON, BUDGET_SCOPES } from "./app-config.ts";

/** The longest App Store AppTransaction JWS the token exchange reads. */
export const MAX_APP_TRANSACTION_LENGTH = 16_384;

/**
 * The longest App Attest attestation (base64) the gateway reads. A real one,
 * with its receipt, is about 6 to 8 KB (Apple's published sample is 7.9 KB),
 * but its size is Apple's to grow, so the cap leaves plenty of room. The CBOR
 * reader's entry cap is what bounds the memory it can use.
 */
export const MAX_ATTESTATION_LENGTH = 65_536;

/**
 * The longest App Attest assertion (base64 or base64url) the gateway reads, in
 * a body or an `X-AppAttest-Proof` header. A real one is a few hundred bytes;
 * this is far above that and well below a header's limit.
 */
export const MAX_ASSERTION_LENGTH = 8_192;

const AppAttestKeyIdSchema = z.string().min(1).max(200);
const ChallengeSchema = z.string().min(1).max(200);

/**
 * `issuer_token` is optional here because one document serves every app. The
 * token exchange makes it required or refused from the app's
 * `end_user.source` before parsing.
 */
export const AppAttestRegisterRequestSchema = z
  .object({
    issuer_token: z.string().min(1).optional(),
    key_id: AppAttestKeyIdSchema,
    attestation: z.string().min(1).max(MAX_ATTESTATION_LENGTH),
    challenge: ChallengeSchema,
  })
  .meta({ id: "AppAttestRegisterRequest" });

export const AppAttestTokenRequestSchema = z
  .object({
    issuer_token: z.string().min(1).optional(),
    key_id: AppAttestKeyIdSchema,
    assertion: z.string().min(1).max(MAX_ASSERTION_LENGTH),
    challenge: ChallengeSchema,
    app_transaction: z.string().min(1).max(MAX_APP_TRANSACTION_LENGTH).optional().meta({
      description:
        "The App Store's signed AppTransaction (its JWS), which names the Apple Account the install belongs to. When present, the assertion signs client data that also carries app_transaction: the unpadded base64url SHA-256 of this string. One that does not verify names no account, and the install is counted on its own.",
    }),
  })
  .meta({ id: "AppAttestTokenRequest" });

export const ApiKeyTokenRequestSchema = z
  .object({
    issuer_token: z.string().min(1),
    api_key: z.string().min(1),
  })
  .strict()
  .meta({ id: "ApiKeyTokenRequest" });

const ReportedErrorSchema = z.object({
  domain: z.string().min(1).max(256).meta({
    description:
      "The error's domain, such as com.apple.devicecheck.error. Stored only when it is a short token (letters, digits, dots, underscores and hyphens, at most 64 characters); anything else is stored as other.",
  }),
  code: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
});

/** Not strict: a newer client may send fields this gateway does not know, and a report is better kept without them. */
export const AppAttestFailureReportSchema = z
  .object({
    challenge: ChallengeSchema,
    step: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/, { error: "step must be a short lowercase token, such as attest_key" })
      .meta({
        description:
          "The step that failed after the challenge was issued: attest_key, generate_assertion, issuer_token, register or token.",
      }),
    error: ReportedErrorSchema,
    underlying_error: ReportedErrorSchema.optional(),
    recovered: z.boolean().optional().meta({
      description: "True when the app recovered by itself, such as by registering a new key. Recorded as client_recovered.",
    }),
  })
  .meta({ id: "AppAttestFailureReport" });

export const AppAttestChallengeResponseSchema = z
  .object({
    challenge: z.string(),
    expires_in: z.number(),
    accepts_app_transaction: z.boolean().optional().meta({
      description: "True when the token exchange accepts app_transaction. A client sends one, and signs over its hash, only when this says so.",
    }),
  })
  .meta({ id: "AppAttestChallengeResponse" });

export const AppAttestRegisterResponseSchema = z.object({ user_id: z.string() }).meta({ id: "AppAttestRegisterResponse" });

export const AppAttestFailureReportResponseSchema = z
  .object({
    recorded: z.boolean().meta({
      description: "False when the challenge was never issued for this app, or was already spent or reported.",
    }),
  })
  .meta({ id: "AppAttestFailureReportResponse" });

export const GatewayTokenResponseSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number(),
    verify_on: z.enum(APP_ATTEST_VERIFY_ON).optional().meta({
      description:
        "On App Attest apps: every_request means every request sent with this token must carry X-AppAttest-Proof; token_exchange means requests carry only the token. Absent on other apps.",
    }),
  })
  .meta({ id: "GatewayTokenResponse" });

/**
 * Who the caller is, the limits the app sets on them, and where they stand,
 * with v1's field names. Money is in dollars here, as v1 sends it, because
 * apps and the Swift SDK read these fields; it is converted from nano-dollars
 * at this edge. The plan allowance is not reported: it is the account's
 * business, reported on the refusal that spends it.
 */
export const CurrentUserResponseSchema = z
  .object({
    user_id: z.string(),
    install_id: z.string().nullable().meta({
      description: "The App Attest key id of the install making the request, on App Attest apps. Null on server apps.",
    }),
    limits: z.object({
      requests_today: z.number().int().nullable().meta({
        description: "Requests made so far in the current UTC day: by this install on an App Attest app, by this user on a server app. Null when the app sets no per-user limit, in which case requests are not counted.",
      }),
      requests_remaining: z.number().int().nullable().meta({ description: "What is left of requests_per_day. Null when no daily limit is set." }),
      requests_per_minute: z.number().nullable().meta({ description: "The per-minute limit on each install (App Attest) or user (server). Null means unlimited." }),
      requests_per_day: z.number().nullable().meta({ description: "The per-day limit on each install (App Attest) or user (server). Null means unlimited." }),
      monthly_cost_usd: z.number().nullable().meta({
        description: "Spent so far in the current UTC month against the budget below, by whoever budget_scope names. Null when the total could not be read in time.",
      }),
      monthly_budget_usd: z.number().nullable().meta({ description: "The monthly budget on each Apple Account, install or user. Null means unlimited." }),
      budget_scope: z.enum(BUDGET_SCOPES).meta({ description: "Whose month monthly_cost_usd is: apple_account, install or user." }),
      blocked: z.boolean().meta({ description: "Whether this user has been blocked in the console." }),
    }),
  })
  .meta({ id: "CurrentUserResponse" });
