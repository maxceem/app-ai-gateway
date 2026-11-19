/**
 * The app configuration, as stored in `app.config_json`.
 *
 * Step 1a part 2 defines only `authentication`, ported from v1 with the same
 * fields and rules. The rest of the configuration (providers, operations,
 * presets, limits) comes with the management API in part 3.
 *
 * Plain `zod`, so the console and the CLI can import it.
 */
import { z } from "zod";
import { BUILT_IN_PROVIDERS } from "../providers/index.ts";

export const APP_ATTEST_ENVIRONMENTS = ["production", "development"] as const;
export const APP_ATTEST_VERIFY_ON = ["every_request", "token_exchange"] as const;
export const ISSUER_PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "custom"] as const;
export const ENTITLEMENT_CHECKS = ["revenuecat", "custom"] as const;

/** RFC 9110 field names. */
export const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
const APPLE_BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** A claim value that is not blank. Without a flag, because it is published as an OpenAPI `pattern`. */
const ClaimTextSchema = z.string().trim().regex(/\S/, { error: "must not be blank" });

const ClaimRequirementSchema = z
  .object({
    path: ClaimTextSchema,
    contains: z.union([ClaimTextSchema, z.array(ClaimTextSchema).min(1)]).optional(),
    equals: z.union([ClaimTextSchema, z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Exactly one: both say two things about one claim, and neither would admit everybody.
    if ((value.contains === undefined) === (value.equals === undefined)) {
      context.addIssue({ code: "custom", message: "Claim requirements need exactly one of contains or equals" });
    }
  });

/** One value or a list of alternatives, always stored as a list. */
const IssuerClaimValuesSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));

/**
 * Headers the gateway already uses, which an app may name neither as its end
 * user id header nor as its issuer token header. That includes every built-in
 * provider's key header, so a provider key is never read as a user id.
 */
const RESERVED_APP_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-appattest-proof",
  ...Object.values(BUILT_IN_PROVIDERS).map((provider) => provider.auth.header.toLowerCase()),
  "x-app-version",
  "x-client-sdk",
  "x-client-trace-id",
  "x-conversation-storage",
  "content-type",
  "content-length",
  "host",
]);

function refuseReservedHeader(header: string, context: z.RefinementCtx): void {
  if (RESERVED_APP_HEADERS.has(header)) {
    context.addIssue({ code: "custom", message: `cannot be ${header}: the gateway already uses that header` });
  }
}

const IssuerAuthenticationSchema = z
  .object({
    /** HTTPS only: the keys that verify every token must not travel in plain text. */
    jwks_url: z
      .url({ protocol: /^https$/, error: "Issuer JWKS URLs must be valid and use HTTPS" })
      .overwrite((value) => {
        try {
          return new URL(value).toString();
        } catch {
          return value;
        }
      })
      .meta({ description: "An https URL. Stored in the canonical form `URL` prints." }),
    /**
     * Required: several issuers publish one JWKS for all their customers, so
     * without `iss` and `aud` a token from someone else's project would verify.
     */
    issuer: IssuerClaimValuesSchema,
    audience: IssuerClaimValuesSchema,
    user_id_claim: z.string().min(1),
    /** Lowercased, because header lookups ignore case. */
    token_header: z.string().min(1).toLowerCase().superRefine(refuseReservedHeader).optional(),
    required_claims: z.array(ClaimRequirementSchema),
    max_token_lifetime_seconds: z.number().int().positive(),
    /** Bookkeeping for the console. The gateway verifies tokens from the fields above. */
    provider: z.enum(ISSUER_PROVIDERS).optional(),
    entitlement: z.enum(ENTITLEMENT_CHECKS).optional(),
  })
  .strict();

/** A header name for the end user id, lowercased. */
const EndUserHeaderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(HTTP_FIELD_NAME, { error: "must be a valid HTTP header name" })
  .superRefine(refuseReservedHeader);

const HeaderEndUserSchema = z.object({ source: z.literal("header"), header: EndUserHeaderSchema }).strict();
const IssuerEndUserSchema = z.object({ source: z.literal("issuer"), issuer: IssuerAuthenticationSchema }).strict();
const AppInstallEndUserSchema = z.object({ source: z.literal("app_install") }).strict();
const NoEndUserSchema = z.object({ source: z.literal("none") }).strict();

/**
 * Each app type allows only the sources that mean something for it: a server
 * app may have no end users, and an App Attest app always has one, but cannot
 * trust the device to name itself.
 */
const ApiKeyEndUserSchema = z.discriminatedUnion("source", [NoEndUserSchema, HeaderEndUserSchema, IssuerEndUserSchema], {
  error: "authentication.end_user.source must be one of none, header, issuer",
});
const AppAttestEndUserSchema = z.discriminatedUnion("source", [IssuerEndUserSchema, AppInstallEndUserSchema], {
  error: "authentication.end_user.source must be one of issuer, app_install",
});

const AppleAppAttestAuthenticationSchema = z
  .object({
    type: z.literal("apple_app_attest"),
    end_user: AppAttestEndUserSchema,
    app_attest: z
      .object({
        team_id: z.string().trim().regex(APPLE_TEAM_ID, { error: "team_id must contain ten uppercase letters or digits" }),
        bundle_id: z.string().trim().regex(APPLE_BUNDLE_ID, { error: "bundle_id must be a reverse DNS identifier" }),
        /**
         * Production only by default: a development-signed build can be
         * debugged on any device with the team's profile, so accepting it is a
         * deliberate choice.
         */
        environments: z
          .array(z.enum(APP_ATTEST_ENVIRONMENTS))
          .min(1, { error: "environments must name at least one environment" })
          .refine((values) => new Set(values).size === values.length, { error: "environments cannot repeat a value" })
          .prefault(["production"]),
        /**
         * `every_request` (the default): every request carries a fresh
         * assertion over itself, so a copied token is worthless.
         * `token_exchange`: the assertion is checked only when the hourly
         * gateway token is exchanged.
         */
        verify_on: z
          .enum(APP_ATTEST_VERIFY_ON, { error: "verify_on must be one of every_request, token_exchange" })
          .default("every_request"),
      })
      .strict(),
  })
  .strict();

const ApiKeyAuthenticationSchema = z
  .object({
    type: z.literal("api_key"),
    /** Required: having no end users is a choice (`none`), not a default. */
    end_user: ApiKeyEndUserSchema,
  })
  .strict();

export const AuthenticationConfigSchema = z.discriminatedUnion("type", [
  AppleAppAttestAuthenticationSchema,
  ApiKeyAuthenticationSchema,
]);

export type AuthenticationConfig = z.output<typeof AuthenticationConfigSchema>;
export type AppleAppAttestAuthentication = Extract<AuthenticationConfig, { type: "apple_app_attest" }>;
export type AppAttestEndUser = AppleAppAttestAuthentication["end_user"];
export type AppAttestEnvironment = (typeof APP_ATTEST_ENVIRONMENTS)[number];
export type IssuerAuthentication = z.output<typeof IssuerAuthenticationSchema>;
export type ClaimRequirement = z.output<typeof ClaimRequirementSchema>;

/** A stored configuration that does not parse. Requests to that app are refused. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The `authentication` part of a stored `config_json`. */
export function parseAuthentication(config: unknown): AuthenticationConfig {
  const raw = typeof config === "object" && config !== null ? (config as { authentication?: unknown }).authentication : undefined;
  const parsed = AuthenticationConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? "" : ["authentication", ...issue.path].join(".");
  throw new ConfigError(`${where}: ${issue?.message ?? "is invalid"}`);
}
