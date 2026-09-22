import { z } from "zod";
import { MAX_BASE_URL_LENGTH } from "../core/origin-guard.ts";
import {
  ENDPOINT_API_STYLES,
  OUTPUT_CLAMP_STYLES,
} from "../shared/capabilities.ts";
import { PROVIDER_CREDENTIAL_HEADERS, PROVIDER_TYPES } from "../shared/providers.ts";

/**
 * The vocabulary an application configuration is written in.
 *
 * It lives beside the schema that enforces it rather than in `src/shared`,
 * because the schema *is* the grammar now: one parser, one set of patterns, and
 * nothing that can drift from it. `src/shared/app-config.ts` re-exports these
 * for the callers that have always read them from there.
 */
export const ISSUER_PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "custom"] as const;
export const ENTITLEMENT_CHECKS = ["revenuecat", "custom"] as const;
export const APP_ATTEST_ENVIRONMENTS = ["production", "development"] as const;
export const DEFAULT_END_USER_HEADER = "x-end-user-id";
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Apple's ten-character team identifier, as the developer portal prints it. */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
/** A reverse-DNS bundle identifier: at least two dot-separated labels. */
const APPLE_BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Keys a configuration may never name, wherever it supplies its own.
 *
 * Every one of them is a legal own property on a JSON object and a member of
 * `Object.prototype`, so a lookup that reached the prototype would resolve a
 * provider, a rewrite or an endpoint nobody configured. The reads themselves
 * are already own-property-only; refusing the keys means the question never
 * arises, and no stored configuration can be written to pose it.
 *
 * `__proto__` is refused in the same breath, but zod removes it from a record
 * before any check can see it — which is the same outcome by a shorter route:
 * it is never parsed, and so never stored.
 */
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const RESERVED_KEY_ERROR = "key cannot be __proto__, constructor or prototype";

const safeKey = <T extends z.ZodString>(schema: T): T =>
  schema.refine((key) => !RESERVED_OBJECT_KEYS.has(key), { error: RESERVED_KEY_ERROR });

/**
 * Descriptor-driven, and the only gate there is: the `provider.type` column
 * carries whatever is stored, and a type is creatable exactly once
 * `PROVIDER_DESCRIPTORS` says how to reach, authenticate and price it. The
 * database is permissive; the runtime table is authoritative.
 */
export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);

/**
 * A request-count limit: a whole number of requests, or null for unlimited.
 * Zero is not a limit, it is a closed door, and is rejected as a likely typo.
 */
const NullableRequestLimit = z.number().int().positive().nullable();

/**
 * A spending limit in USD, or null for unlimited. Zero is allowed and means no
 * spend. Bounded above by what survives the conversion to whole microdollars
 * the limiter counts in: past that a budget silently stops being the number
 * that was typed.
 */
const NullableSpendLimit = z.number()
  .nonnegative()
  .refine((usd) => Number.isSafeInteger(Math.round(usd * 1_000_000)), {
    error: "monthly_usd is too large",
  })
  .nullable();
/**
 * A provider instance slug: the `{slug}` segment of `/proxy/{slug}/…`, and the
 * key an application's routing policy names an instance by.
 *
 * Reserved keys are refused here rather than where the policy is keyed, so a
 * slug that no configuration could ever reference cannot be claimed in the
 * first place. `__proto__` never reaches the check — the pattern has no
 * underscore — leaving `constructor` and `prototype`, which the pattern does
 * admit and which every plain object already answers to.
 */
export const SlugSchema = safeKey(
  z.string().regex(PROVIDER_SLUG_PATTERN).meta({
    description:
      "Lowercase letters, digits and hyphens, starting with a letter or digit. `constructor` and `prototype` are reserved.",
  }),
);

/**
 * The same slug on the way out, without the reserved-name refusal.
 *
 * A row created before that rule existed still has to be readable: a client
 * that parses responses — the CLI does — would otherwise fail to list an
 * organization's providers because one of them holds a name it may no longer
 * choose. Refusing on the way in is what makes the rule; refusing on the way
 * out would only hide the row that needs renaming.
 */
export const StoredSlugSchema = z.string().regex(PROVIDER_SLUG_PATTERN);

const ClaimRequirementSchema = z.object({
  path: z.string().min(1),
  contains: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict().superRefine((value, context) => {
  // Exactly one: a requirement with both says two different things about the
  // same claim, and one with neither says nothing and would admit everybody.
  if ((value.contains === undefined) === (value.equals === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Claim requirements need exactly one of contains or equals",
    });
  }
});

/**
 * One value or a list of alternatives, for the two claims that scope an app to
 * a tenant. A list covers a migration between two issuers or bundle ids.
 *
 * Stored as a list either way: the gateway compares against a set, and a single
 * string is just the one-element case of it. Writing that normalization here
 * rather than at each read is what lets the stored form be the parsed form.
 */
const IssuerClaimValuesSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));

const IssuerAuthenticationSchema = z.object({
  /**
   * HTTPS only, and stored in the canonical form `URL` prints: the gateway
   * fetches this on the authentication path, so a plaintext origin would put
   * the keys that verify every token on the wire for anyone to replace.
   */
  jwks_url: z.url({ protocol: /^https$/, error: "Issuer JWKS URLs must be valid and use HTTPS" })
    // Guarded, because a check still runs on a value the format check has
    // already rejected, and `new URL` on one of those throws out of the parse.
    .overwrite((value) => {
      try {
        return new URL(value).toString();
      } catch {
        return value;
      }
    })
    .meta({ description: "An https URL. Stored in the canonical form `URL` prints." }),
  /**
   * Required: several issuers publish one JWKS for every customer — Firebase
   * signs all projects with the same keys — so without `iss` and `aud` a token
   * minted in an attacker's own project verifies against this app.
   */
  issuer: IssuerClaimValuesSchema,
  audience: IssuerClaimValuesSchema,
  user_id_claim: z.string().min(1),
  /** Lowercased, because header lookups ignore case. */
  token_header: z.string().min(1).toLowerCase().optional(),
  required_claims: z.array(ClaimRequirementSchema),
  max_token_lifetime_seconds: z.number().int().positive(),
  /**
   * Which identity provider the three scoping fields were written for, and
   * which kind of paid-user check `required_claims` implements. Bookkeeping for
   * the console, so it can show "Firebase, project X" and reopen the same
   * form: the gateway verifies tokens from the fields above and reads neither.
   *
   * Refused rather than dropped when this build does not know the name: this
   * schema is checked on the way in, so a name it cannot interpret never
   * reaches storage in the first place.
   */
  provider: z.enum(ISSUER_PROVIDERS).optional(),
  entitlement: z.enum(ENTITLEMENT_CHECKS).optional(),
}).strict();

/**
 * Headers the gateway already owns, which an application may therefore not read
 * its end-user id from. Naming a credential carrier would read the caller's own
 * key as a user id and then store and display it.
 */
const RESERVED_END_USER_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  ...PROVIDER_CREDENTIAL_HEADERS,
  "x-app-version",
  "content-type",
  "content-length",
  "host",
]);

/**
 * A header name, as HTTP defines one (RFC 9110 field names). Bounded because it
 * is echoed into error messages and compared on every request, and lowercased
 * here since header lookups ignore case.
 */
const EndUserHeaderSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(HTTP_FIELD_NAME, { error: "must be a valid HTTP header name" })
  .superRefine((header, context) => {
    if (RESERVED_END_USER_HEADERS.has(header)) {
      context.addIssue({
        code: "custom",
        message: `cannot be ${header}: the gateway already uses that header`,
      });
    }
  });

const HeaderEndUserSchema = z.object({
  source: z.literal("header"),
  header: EndUserHeaderSchema,
}).strict();

const IssuerEndUserSchema = z.object({
  source: z.literal("issuer"),
  issuer: IssuerAuthenticationSchema,
}).strict();

const AppInstallEndUserSchema = z.object({
  source: z.literal("app_install"),
}).strict();

/**
 * Each application type admits only the sources that can mean anything for it,
 * so an impossible pairing is a schema error rather than a rule someone has to
 * remember: an `api_key` app has no attested key, and an App Attest client is
 * the end user's own device and so cannot be trusted to name itself.
 */
const ApiKeyEndUserSchema = z.discriminatedUnion("source", [
  HeaderEndUserSchema,
  IssuerEndUserSchema,
], { error: "authentication.end_user.source must be one of header, issuer" });

const AppAttestEndUserSchema = z.discriminatedUnion("source", [
  IssuerEndUserSchema,
  AppInstallEndUserSchema,
], { error: "authentication.end_user.source must be one of issuer, app_install" });

const AppleAppAttestAuthenticationSchema = z.object({
  type: z.literal("apple_app_attest"),
  end_user: AppAttestEndUserSchema,
  app_attest: z.object({
    team_id: z.string().regex(APPLE_TEAM_ID, {
      error: "team_id must contain ten uppercase letters or digits",
    }),
    bundle_id: z.string().regex(APPLE_BUNDLE_ID, {
      error: "bundle_id must be a reverse DNS identifier",
    }),
    /**
     * Which of Apple's two App Attest environments this application accepts.
     * Defaulted to `["production"]` alone, because a development-signed build
     * stamps a different aaguid and is debuggable on any device carrying the
     * team's provisioning profile. Accepting one is therefore a deliberate
     * per-application opt-in, and belongs on a development bundle id rather
     * than the one shipped to the App Store.
     */
    environments: z.array(z.enum(APP_ATTEST_ENVIRONMENTS))
      .min(1, { error: "environments must name at least one environment" })
      .refine((values) => new Set(values).size === values.length, {
        error: "environments cannot repeat a value",
      })
      .prefault(["production"]),
  }).strict(),
}).strict();

const ApiKeyAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  /**
   * Omitted means the application has no end users, which is a position rather
   * than a default: nothing is metered or blocked per user, and `limits.per_user`
   * is refused as meaningless. Naming a source is how an application opts into
   * having users at all.
   */
  end_user: ApiKeyEndUserSchema.optional(),
}).strict();

const AllowedPathSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    fixed_model: z.string().min(1).optional(),
    clamp: z.enum(OUTPUT_CLAMP_STYLES).optional(),
  }).strict(),
]);

/**
 * What one provider instance may be asked for. Both lists are required on the
 * wire — empty means "no restriction", which is a different statement from
 * "unspecified", and the console's draft layer materializes them.
 */
const ProviderPolicySchema = z.object({
  allowed_paths: z.array(AllowedPathSchema),
  allowed_models: z.array(z.string().min(1)),
  max_output_tokens: z.number().int().positive().optional(),
}).strict();

const EndpointTargetSchema = z.object({
  provider: SlugSchema,
  model: z.string().min(1),
});

const EndpointSchema = EndpointTargetSchema.extend({
  api_style: z.enum(ENDPOINT_API_STYLES),
  params: z.record(z.string(), z.unknown()).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  fallback: z.array(EndpointTargetSchema).optional(),
}).strict();

const LimitScopeSchema = z.object({
  requests: z.object({
    per_minute: NullableRequestLimit,
    per_day: NullableRequestLimit,
  }).strict(),
  spending: z.object({ monthly_usd: NullableSpendLimit }).strict(),
}).strict();

/** No limit of any kind, which is what an unwritten scope means. */
const UNLIMITED_SCOPE = {
  requests: { per_minute: null, per_day: null },
  spending: { monthly_usd: null },
} as const;

/**
 * Whether an application identifies its end users at all. An App Attest app
 * always does; an `api_key` app does only once it names a source.
 */
export function identifiesEndUsers(
  authentication: { type: string; end_user?: unknown },
): boolean {
  return authentication.type !== "api_key" || authentication.end_user !== undefined;
}

/** Whether a scope sets any limit at all, as opposed to being written out in full as unlimited. */
export const scopeHasLimits = (scope: LimitScopeConfig): boolean =>
  scope.requests.per_minute !== null
  || scope.requests.per_day !== null
  || scope.spending.monthly_usd !== null;

/**
 * An application's configuration: the one grammar, and the one shape.
 *
 * What this schema accepts is what the gateway stores, and what it produces is
 * what every reader — the request path, the console, the CLI — works on. There
 * is no second parser and no resolved projection: the defaults below are
 * applied once, here, so `limits`, `endpoints` and the App Attest environments
 * are always present on a parsed configuration and nobody downstream has to ask
 * whether they were written.
 *
 * Every object is strict. A key this grammar does not define is a client that
 * has misread the contract or a field that has been removed, and both are
 * better answered by name than silently dropped.
 */
export const AppConfigSchema = z.object({
  authentication: z.discriminatedUnion("type", [
    AppleAppAttestAuthenticationSchema,
    ApiKeyAuthenticationSchema,
  ]),
  routing: z.object({
    /**
     * Discriminated, because the two modes carry different fields: `all` names
     * nothing and `selected` must name its policies. Declaring `selected` as an
     * optional member of one object would make "all mode with a selection" and
     * "selected mode with nothing selected" both expressible.
     */
    providers: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("all") }).strict(),
      z.object({
        mode: z.literal("selected"),
        selected: z.record(SlugSchema, ProviderPolicySchema, {
          error: "routing.providers.selected must be keyed by provider instance slug",
        }),
      }).strict(),
    ], { error: "routing.providers.mode must be all or selected" }),
    model_rewrites: z.record(safeKey(z.string().min(1)), z.string().min(1), {
      error: "routing.model_rewrites must be keyed by a model name",
    }),
  }).strict(),
  /**
   * The organization's own limits on its app's end users, always present on a
   * parsed configuration: an unwritten block is the unlimited one.
   */
  limits: z.object({
    per_user: LimitScopeSchema.prefault(UNLIMITED_SCOPE),
    per_app: LimitScopeSchema.prefault(UNLIMITED_SCOPE),
  }).strict().prefault({}),
  endpoints: z.record(
    safeKey(z.string().regex(ENDPOINT_SLUG)),
    EndpointSchema,
    { error: "is not a valid slug; use 1-64 characters from a-z, 0-9, and -" },
  ).prefault({}),
}).strict().superRefine((config, context) => {
  /*
   * Per-user limits need somebody to apply to. An application that identifies
   * no end users has nobody, so a configured `per_user` scope would be a limit
   * that never applies — and an operator who believes they have capped their
   * users. `per_app` is what such an application caps instead.
   */
  // Defensive reads: zod still runs a whole-object check when a member has
  // already been rejected, and then neither of these has been parsed.
  const authentication = config.authentication as AuthenticationConfig | undefined;
  const perUser = config.limits?.per_user as LimitScopeConfig | undefined;
  if (
    authentication !== undefined
    && perUser !== undefined
    && !identifiesEndUsers(authentication)
    && scopeHasLimits(perUser)
  ) {
    context.addIssue({
      code: "custom",
      path: ["limits", "per_user"],
      message:
        "needs an authentication.end_user source: this application identifies no end users, so use limits.per_app",
    });
  }
}).meta({ id: "AppConfig" });

/** What a client may send, and what a parse of it produces. They differ: see the defaults above. */
export type AppConfig = z.output<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;

/**
 * The body of every application write. It carries no `id`: the gateway derives
 * one from `name` on create and answers with it as `app.id`, and no request may
 * choose or change it. Strict, so a client still sending `id` is told that in
 * so many words instead of having it silently ignored.
 */
export const AppWriteSchema = z.object({
  name: z.string().min(1).max(100),
  config: AppConfigSchema,
  status: z.enum(["active", "disabled"]).optional(),
}).strict().meta({ id: "AppWrite" });

/**
 * An update, which is a write plus the revision it is made against.
 *
 * The revision travels in the body and nowhere else. It is a field of the
 * resource — every read already answers with it — and a body is the one channel
 * neither a CDN nor a browser's CORS rules interfere with: an `ETag` is
 * rewritten to its weak form by anything that compresses the response, and is
 * unreadable to a cross-origin client unless the server exposes it. Requiring
 * it here rather than accepting its absence means a client that has not read
 * the application cannot overwrite it blind.
 */
export const AppUpdateSchema = AppWriteSchema.extend({
  revision: z.number().int().positive(),
}).meta({ id: "AppUpdate" });
export type AppUpdate = z.infer<typeof AppUpdateSchema>;

/** The answer to a body that still names an id, wherever one is rejected. */
export const APP_ID_IS_SERVER_ASSIGNED =
  "id is assigned by the server: omit it and read app.id from the response";

/**
 * Apple's key id is the base64 SHA-256 of the public key — 44 characters — and
 * a challenge is this gateway's own base64url of 32 bytes. Both are bounded
 * because these routes are unauthenticated and, under the `app_install` source,
 * the key id becomes an end-user id that is stored and displayed.
 */
const AppAttestKeyIdSchema = z.string().min(1).max(200);
const ChallengeSchema = z.string().min(1).max(200);

/**
 * `issuer_token` is optional here and required by the route instead, because
 * whether one is needed is a property of the application: an `app_install`
 * application identifies its user by the attested key alone and has no issuer to
 * present a token from. The route answers for the mismatch, which is the only
 * place that knows what the application asked for.
 */
export const AppAttestRegisterRequestSchema = z.object({
  issuer_token: z.string().min(1).optional(),
  key_id: AppAttestKeyIdSchema,
  attestation: z.string().min(1),
  challenge: ChallengeSchema,
}).meta({ id: "AppAttestRegisterRequest" });

export const AppAttestTokenRequestSchema = z.object({
  issuer_token: z.string().min(1).optional(),
  key_id: AppAttestKeyIdSchema,
  assertion: z.string().min(1),
  challenge: ChallengeSchema,
}).meta({ id: "AppAttestTokenRequest" });

export const ApiKeyTokenRequestSchema = z.object({
  issuer_token: z.string().min(1),
  api_key: z.string().min(1),
}).strict().meta({ id: "ApiKeyTokenRequest" });

export const UsageRepriceRequestSchema = z.object({
  provider: ProviderTypeSchema,
  model: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  apply: z.boolean().default(false),
}).strict().meta({ id: "UsageRepriceRequest" });

/**
 * Per-1M-token overrides for models the shipped catalog does not cover, or
 * covers with a stale price. `$0` is enterable for genuinely free models.
 */
export const ProviderPricingSchema = z.record(
  z.string().trim().min(1).max(200),
  z.object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
  }).strict(),
).meta({ id: "ProviderPricing" });

const ProviderNameSchema = z.string().trim().min(1).max(100);
const ProviderSecretSchema = z.string().min(1).max(4096);

/**
 * An operator's own origin for a direct provider instance. Only the shape is
 * checked here; the rules that make it safe — https, a public registrable host,
 * no port, no credentials, no query — live in `src/core/origin-guard.ts`, which
 * also returns the canonical form that is stored. Keeping them there means one
 * implementation for the write paths, the probe, and any future reuse, rather
 * than a regex in a contract that would inevitably drift from it.
 */
const ProviderBaseUrlSchema = z.string().trim().min(1).max(MAX_BASE_URL_LENGTH);

/** Says why the two fields are exclusive, rather than that one is invalid. */
function assertBaseUrlIsDirect(
  value: { baseUrl?: string; providerGatewayId?: string },
  context: z.RefinementCtx,
): void {
  if (value.baseUrl !== undefined && value.providerGatewayId !== undefined) {
    context.addIssue({
      code: "custom",
      message:
        "A gateway-routed instance cannot carry a base URL: the gateway owns the upstream origin",
      path: ["baseUrl"],
    });
  }
}

/**
 * How one provider row is routed inside its gateway. The referenced gateway's
 * type selects what is meaningful here, and its adapter rejects the rest — a
 * Cloudflare AI Gateway, for instance, accepts no routing configuration at all.
 */
export const GatewayRouteConfigSchema = z.object({
  modelPrefix: z.string().trim().min(1).max(100).optional(),
  providerOnly: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
}).strict().meta({ id: "GatewayRouteConfig" });

export const ProviderCreateRequestSchema = z.object({
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  slug: SlugSchema.optional(),
  secret: ProviderSecretSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  gatewayRoute: GatewayRouteConfigSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  pricing: ProviderPricingSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderCreateRequest" });

/**
 * A dry run of {@link ProviderCreateRequestSchema}: the same credential, minus
 * everything that only matters once a row is stored.
 */
export const ProviderTestRequestSchema = z.object({
  type: ProviderTypeSchema,
  secret: ProviderSecretSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  /** Probed at the origin the instance would really use, override included. */
  baseUrl: ProviderBaseUrlSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderTestRequest" });

/**
 * One member per gateway type that has an adapter, discriminated by `type`
 * because each gateway needs a different set of non-secret fields to be
 * reachable at all. The stored `type` column already admits every planned name,
 * so adding a gateway is an adapter plus a member here — never a table rebuild.
 *
 * Vercel asks for nothing but a name and a token: its origin is fixed in
 * adapter code, and the token alone identifies the Vercel team.
 */
export const ProviderGatewayCreateRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cf_aig"),
    name: ProviderNameSchema,
    accountId: z.string().trim().min(1).max(100),
    gatewayId: z.string().trim().min(1).max(100),
    token: ProviderSecretSchema,
  }).strict(),
  z.object({
    type: z.literal("vercel"),
    name: ProviderNameSchema,
    token: ProviderSecretSchema,
  }).strict(),
], {
  error: "Provider gateway type must be one of cf_aig, vercel",
}).meta({ id: "ProviderGatewayCreateRequest" });

/**
 * A dry run of {@link ProviderGatewayCreateRequestSchema}: the same members
 * minus the name, so the connection is probed exactly as a create would probe
 * it, without a row having to exist.
 */
export const ProviderGatewayTestRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cf_aig"),
    accountId: z.string().trim().min(1).max(100),
    gatewayId: z.string().trim().min(1).max(100),
    token: ProviderSecretSchema,
  }).strict(),
  z.object({
    type: z.literal("vercel"),
    token: ProviderSecretSchema,
  }).strict(),
], {
  error: "Provider gateway type must be one of cf_aig, vercel",
}).meta({ id: "ProviderGatewayTestRequest" });

export const ProviderGatewayUpdateRequestSchema = z.object({
  name: ProviderNameSchema,
  revision: z.number().int().positive().meta({ description: "The gateway revision returned by the read this edit is based on." }),
}).strict().meta({ id: "ProviderGatewayUpdateRequest" });

export const ProviderGatewayRotateRequestSchema = z.object({
  token: ProviderSecretSchema,
  revision: z.number().int().positive().meta({ description: "The gateway revision returned by the read this rotation is based on." }),
}).strict().meta({ id: "ProviderGatewayRotateRequest" });

/**
 * Why a new origin comes with a new key. A provider secret is write-only: it is
 * encrypted on the way in and never read back out to a caller, and that has to
 * include reading it back out *through* an origin the operator just typed.
 * Decrypting the stored key to probe a fresh host would make the base URL field
 * a way for an admin, or a management-key holder, to have the gateway hand the
 * organization's key to a server they control.
 */
export const BASE_URL_REQUIRES_SECRET =
  "Changing the base URL requires re-supplying the provider key, because the stored key is never sent to a new origin";

export const ProviderUpdateRequestSchema = z.object({
  revision: z.number().int().positive().meta({ description: "The provider revision returned by the read this update is based on." }),
  name: ProviderNameSchema.optional(),
  secret: ProviderSecretSchema.optional(),
  /** A full replace; `null` clears the row's routing configuration. */
  gatewayRoute: GatewayRouteConfigSchema.nullable().optional(),
  /**
   * `null` returns the instance to its provider type's own base URL, and needs
   * nothing else. Any other value needs `secret` in the same request; see
   * {@link BASE_URL_REQUIRES_SECRET}.
   */
  baseUrl: ProviderBaseUrlSchema.nullable().optional(),
  /** A full replace; `null` clears every override. */
  pricing: ProviderPricingSchema.nullable().optional(),
  /**
   * A reversible pause. Disabling keeps the secret, the pricing and the slug, so
   * nothing can take the slug meanwhile and re-enabling always succeeds.
   */
  status: z.enum(["active", "disabled"]).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.name === undefined
    && value.secret === undefined
    && value.gatewayRoute === undefined
    && value.baseUrl === undefined
    && value.pricing === undefined
    && value.status === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Provide at least one of name, secret, gatewayRoute, baseUrl, pricing, or status",
    });
  }
  if (value.baseUrl !== undefined && value.baseUrl !== null && value.secret === undefined) {
    context.addIssue({ code: "custom", message: BASE_URL_REQUIRES_SECRET, path: ["secret"] });
  }
}).meta({ id: "ProviderUpdateRequest" });

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);

export const OrganizationSelectRequestSchema = z.object({
  organizationId: z.string().trim().min(1),
}).meta({ id: "OrganizationSelectRequest" });

/**
 * The one field a credential is created with. Both key surfaces take a name and
 * nothing else — the token itself is minted here, never supplied — so they
 * share one shape rather than two that could drift apart.
 */
export const CredentialNameRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export const ManagementKeyCreateRequestSchema = CredentialNameRequestSchema
  .meta({ id: "ManagementKeyCreateRequest" });
export const ApiKeyCreateRequestSchema = CredentialNameRequestSchema
  .meta({ id: "ApiKeyCreateRequest" });

/** Inferred request bodies, so a consumer never re-describes one by hand. */
export type AppWrite = z.output<typeof AppWriteSchema>;
/** The same body as a client composes it, before the schema's defaults apply. */
export type AppWriteInput = z.input<typeof AppWriteSchema>;
export type ClaimRequirement = z.output<typeof ClaimRequirementSchema>;
export type IssuerAuthentication = z.output<typeof IssuerAuthenticationSchema>;
export type IssuerAuthenticationInput = z.input<typeof IssuerAuthenticationSchema>;
export type IssuerProvider = (typeof ISSUER_PROVIDERS)[number];
export type EntitlementCheck = (typeof ENTITLEMENT_CHECKS)[number];
export type ApiKeyEndUser = z.output<typeof ApiKeyEndUserSchema>;
export type AppAttestEndUser = z.output<typeof AppAttestEndUserSchema>;
export type AppAttestEnvironment = (typeof APP_ATTEST_ENVIRONMENTS)[number];
export type AuthenticationConfig = AppConfig["authentication"];
/** The same block as a client may send it, which is what a half-filled form is. */
export type AuthenticationConfigInput = AppConfigInput["authentication"];
export type AppleAppAttestAuthentication = Extract<
  AuthenticationConfig,
  { type: "apple_app_attest" }
>;
export type ApiKeyAuthentication = Extract<AuthenticationConfig, { type: "api_key" }>;
export type ProviderPolicy = z.output<typeof ProviderPolicySchema>;
export type RoutingConfig = AppConfig["routing"];
export type LimitScopeConfig = z.output<typeof LimitScopeSchema>;
export type LimitsConfig = AppConfig["limits"];
export type EndpointConfig = z.output<typeof EndpointSchema>;
export type EndpointsConfig = AppConfig["endpoints"];
export type GatewayRouteConfigInput = z.infer<typeof GatewayRouteConfigSchema>;
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;
export type OrganizationSelectRequest = z.infer<typeof OrganizationSelectRequestSchema>;
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;
export type ProviderCreateRequest = z.infer<typeof ProviderCreateRequestSchema>;
export type ProviderUpdateRequest = z.infer<typeof ProviderUpdateRequestSchema>;
export type ProviderTestRequest = z.infer<typeof ProviderTestRequestSchema>;
export type ProviderGatewayCreateRequest = z.infer<typeof ProviderGatewayCreateRequestSchema>;
export type ProviderGatewayTestRequest = z.infer<typeof ProviderGatewayTestRequestSchema>;
export type ProviderGatewayUpdateRequest = z.infer<typeof ProviderGatewayUpdateRequestSchema>;
export type ProviderGatewayRotateRequest = z.infer<typeof ProviderGatewayRotateRequestSchema>;
export type UsageRepriceRequest = z.infer<typeof UsageRepriceRequestSchema>;
export type ManagementKeyCreateRequest = z.infer<typeof ManagementKeyCreateRequestSchema>;
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequestSchema>;
