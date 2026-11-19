/**
 * Bodies of the app authentication routes (`/v2/apps/{app}/auth/*` and
 * `/v2/apps/{app}/me`). The field names are v1's, so the Swift SDK only
 * changes its path prefix.
 */
import { z } from "zod";
import { APP_ATTEST_VERIFY_ON } from "./app-config.ts";

/** The longest App Store AppTransaction JWS the token exchange reads. */
export const MAX_APP_TRANSACTION_LENGTH = 16_384;

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
    attestation: z.string().min(1),
    challenge: ChallengeSchema,
  })
  .meta({ id: "AppAttestRegisterRequest" });

export const AppAttestTokenRequestSchema = z
  .object({
    issuer_token: z.string().min(1).optional(),
    key_id: AppAttestKeyIdSchema,
    assertion: z.string().min(1),
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
 * Who the caller is. Step 1b adds the limits that apply to them and where
 * they stand, as a new field.
 */
export const CurrentUserResponseSchema = z
  .object({
    user_id: z.string(),
    install_id: z.string().nullable().meta({
      description: "The App Attest key id of the install making the request, on App Attest apps. Null on server apps.",
    }),
    blocked: z.boolean().meta({ description: "Whether this user has been blocked in the console." }),
  })
  .meta({ id: "CurrentUserResponse" });
