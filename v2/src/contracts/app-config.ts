/**
 * The app configuration, as stored in `app.config_json`.
 *
 * `authentication` is ported from v1 with the same fields and rules.
 * `routing` says which provider connections an app may call, which of their
 * declared operations, which models, an output cap, and model rewrites (v1's
 * `routing.model_rewrites`). `presets` are v1's custom endpoints (plan
 * section 4.4), each with its fallback chain. `conversations` is v1's
 * conversation storage (step 7), an optional key.
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
 * user id header nor as its issuer token header. Every built-in provider's key
 * header is refused too, but only when settings are saved
 * (`providerKeyHeaderProblem`): a provider added in a later release must not
 * make a stored app that already names its header unreadable.
 */
const RESERVED_APP_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-appattest-proof",
  // The key headers of the providers step 1 had, which stored apps never named.
  "xi-api-key",
  "x-app-version",
  "x-client-sdk",
  "x-client-trace-id",
  "x-conversation-storage",
  "content-type",
  "content-length",
  "host",
]);

/**
 * The headers the gateway reads who is calling and their proof from, besides
 * `Authorization`: the conventional end-user header, App Attest's proof, and
 * the client SDK's own headers. A provider key header may never be one of
 * them (a custom provider's is refused when saved, `src/providers/custom.ts`),
 * and a request's app key is never read from one (`src/client-auth/client-auth.ts`).
 */
export const GATEWAY_IDENTITY_HEADERS: ReadonlySet<string> = new Set([
  "x-end-user-id",
  "x-appattest-proof",
  "x-app-version",
  "x-client-sdk",
  "x-client-trace-id",
  "x-conversation-storage",
]);

/** Every built-in provider's key header, so a provider key is never read as a user id. */
const PROVIDER_KEY_HEADERS: ReadonlySet<string> = new Set(
  Object.values(BUILT_IN_PROVIDERS).map((provider) => provider.auth.header.toLowerCase()),
);

/**
 * Why an app's end-user or issuer token header cannot be saved: it is a
 * built-in provider's key header. Checked when settings are saved only.
 */
export function providerKeyHeaderProblem(config: AppConfig): string | null {
  const endUser = config.authentication.end_user;
  const named: [string, string | undefined][] = [
    ["authentication.end_user.header", endUser.source === "header" ? endUser.header : undefined],
    ["authentication.end_user.issuer.token_header", endUser.source === "issuer" ? endUser.issuer.token_header : undefined],
  ];
  for (const [path, header] of named) {
    if (header !== undefined && PROVIDER_KEY_HEADERS.has(header)) return `${path}: cannot be ${header}: the gateway already uses that header`;
  }
  return null;
}

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

/** An iOS app's Apple team id. Shared with `patch_app`'s shortcut (`../mcp/shortcuts.ts`). */
export const AppleTeamIdSchema = z.string().trim().regex(APPLE_TEAM_ID, { error: "team_id must contain ten uppercase letters or digits" });
/** An iOS app's bundle id. Shared with `patch_app`'s shortcut. */
export const AppleBundleIdSchema = z.string().trim().regex(APPLE_BUNDLE_ID, { error: "bundle_id must be a reverse DNS identifier" });
/** The App Attest environments an iOS app accepts, at least one and none twice. Shared with `patch_app`'s shortcut. */
export const AppAttestEnvironmentsSchema = z
  .array(z.enum(APP_ATTEST_ENVIRONMENTS))
  .min(1, { error: "environments must name at least one environment" })
  .refine((values) => new Set(values).size === values.length, { error: "environments cannot repeat a value" });

const AppleAppAttestAuthenticationSchema = z
  .object({
    type: z.literal("apple_app_attest"),
    end_user: AppAttestEndUserSchema,
    app_attest: z
      .object({
        team_id: AppleTeamIdSchema,
        bundle_id: AppleBundleIdSchema,
        /**
         * Production only by default: a development-signed build can be
         * debugged on any device with the team's profile, so accepting it is a
         * deliberate choice.
         */
        environments: AppAttestEnvironmentsSchema.prefault(["production"]),
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

/**
 * The conventional end-user header. Never sent to a provider, whatever header
 * an app names for its end users, as v1.
 */
export const DEFAULT_END_USER_HEADER = "x-end-user-id";

/** A provider connection's slug, as in request paths. */
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ModelNameSchema = z.string().trim().min(1).max(200);

/**
 * What an app may call on one provider connection. Closed by default: only the
 * operations named here, and, where `models` is set, only those models.
 */
export const ProviderRoutingSchema = z
  .object({
    /**
     * Declared operation names, such as `openai.chat`. At least one.
     * `passthrough` lets the app reach the paths the connection lists for
     * passthrough, forwarded as they are.
     */
    operations: z
      .array(z.string().trim().min(1).max(100))
      .min(1, { error: "operations must name at least one operation" })
      .refine((values) => new Set(values).size === values.length, { error: "operations cannot repeat a value" }),
    /** Allowed models. Without it, any model with a price. */
    models: z
      .array(ModelNameSchema)
      .min(1, { error: "models must name at least one model, or be left out" })
      .refine((values) => new Set(values).size === values.length, { error: "models cannot repeat a value" })
      .optional(),
    /** The most output tokens a request may ask for. Written into the request when it asks for none. */
    max_output_tokens: z.number().int().positive().optional(),
  })
  .strict();

/** A model name used as a record key. `__proto__` is refused: as a key it would not be stored. */
const ModelKeySchema = ModelNameSchema.refine((value) => value !== "__proto__", { error: "is not a model name" });

export const RoutingConfigSchema = z
  .object({
    providers: z
      .record(z.string().regex(PROVIDER_SLUG_PATTERN, { error: "must be a provider connection slug" }), ProviderRoutingSchema)
      .default({}),
    /**
     * A model a request names, and the model it is sent and billed as, for
     * every proxy call of the app (v1). The app's model list is judged on the
     * model the request names; the price on the model it becomes. One step
     * only: a rewrite's target is never rewritten again. Presets name their
     * models themselves and are not rewritten. Written only when it has
     * one: an empty list is the default (`AGENTS.md`).
     */
    model_rewrites: z.record(ModelKeySchema, ModelNameSchema).optional(),
  })
  .strict();

export type ProviderRouting = z.output<typeof ProviderRoutingSchema>;
export type RoutingConfig = z.output<typeof RoutingConfigSchema>;

/** A preset's slug, as in `/v2/apps/{app}/presets/{slug}`. */
export const PRESET_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

const OperationNameSchema = z.string().trim().min(1).max(100);

/**
 * One more provider connection and model a preset tries when the one before
 * failed (a fallback). Its operation must speak the preset's API style; left
 * out, it is the connection's first operation of that style.
 */
const PresetFallbackSchema = z
  .object({
    provider: z.string().regex(PROVIDER_SLUG_PATTERN, { error: "must be a provider connection slug" }),
    operation: OperationNameSchema.optional(),
    model: ModelNameSchema,
  })
  .strict();

/**
 * A preset: v1's custom endpoint (plan section 4.4). The app calls it by its
 * slug and sends only the request's own content; the server names the
 * connection, the operation, the model, fixed parameters and an output cap.
 *
 * - `params` are merged into a JSON body, and win over the app's values.
 * - `fallback` is tried in order when an attempt gets no answer, a 429 or a
 *   5xx. Every attempt is one charge; a failed one costs nothing (D13).
 */
export const PresetSchema = z
  .object({
    provider: z.string().regex(PROVIDER_SLUG_PATTERN, { error: "must be a provider connection slug" }),
    operation: OperationNameSchema,
    model: ModelNameSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    fallback: z.array(PresetFallbackSchema).optional(),
  })
  .strict();

export const PresetsConfigSchema = z.record(
  z.string().regex(PRESET_SLUG_PATTERN, { error: "is not a valid preset slug; use 1-64 characters from a-z, 0-9 and -" }),
  PresetSchema,
);

export type Preset = z.output<typeof PresetSchema>;
export type PresetFallback = z.output<typeof PresetFallbackSchema>;
export type PresetsConfig = z.output<typeof PresetsConfigSchema>;

/**
 * Whose month a `limits.per_user` budget is measured over: one install's, one
 * user's, or one Apple Account's (every install of that account, across
 * devices and reinstalls). The budget totals keep each of these
 * (`budget_day`).
 */
export const BUDGET_SCOPES = ["install", "user", "apple_account"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** A request-count limit, or null for none. Zero is refused as a likely typo: it would be a closed door. */
const RequestLimitSchema = z.number().int().positive().nullable();

/**
 * A monthly budget in whole nano-dollars (plan D20), or null for none. Zero is
 * allowed and means no spend. The management API takes and returns it as is;
 * the console and the CLI show dollars (step 2).
 */
const BudgetNanoSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

const RequestLimitsSchema = z
  .object({ per_minute: RequestLimitSchema.default(null), per_day: RequestLimitSchema.default(null) })
  .strict();

/** How many live sessions of each kind an app may have at once, by default (D15). */
export const APP_SESSION_CAPS = { conversational: 10, streaming: 50 } as const;
/** The most an app may set: a guard against a typo, far above any app's need. */
const MAX_APP_SESSIONS = 10_000;

const SessionCapSchema = z.number().int().positive().max(MAX_APP_SESSIONS).optional();

/**
 * The app's live-session caps (D15), each left out while it is the default.
 * At the cap a new session is refused and the customer sees it in the console.
 */
const AppSessionCapsSchema = z
  .object({
    conversational: SessionCapSchema.meta({ description: `Conversational sessions (realtime voice, agents) open at once across the app. Default ${APP_SESSION_CAPS.conversational}.` }),
    streaming: SessionCapSchema.meta({ description: `Streaming text-to-speech and speech-to-text sessions open at once across the app. Default ${APP_SESSION_CAPS.streaming}.` }),
  })
  .strict();

const LimitScopeSchema = z
  .object({
    requests: RequestLimitsSchema.prefault({}),
    spending: z.object({ monthly_nano: BudgetNanoSchema.default(null) }).strict().prefault({}),
  })
  .strict();

const AppLimitScopeSchema = LimitScopeSchema.extend({ sessions: AppSessionCapsSchema.optional() }).strict();

/**
 * The limits on each of an app's callers. On an App Attest app, requests are
 * counted per install, and the budget by default per Apple Account; a server
 * app counts everything per user. As v1, with the budget in nano-dollars.
 */
const PerUserLimitScopeSchema = z
  .object({
    requests: RequestLimitsSchema.prefault({}),
    spending: z
      .object({ monthly_nano: BudgetNanoSchema.default(null), scope: z.enum(BUDGET_SCOPES).optional() })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * The customer's own limits on its app (`app_*`). Never read by, and never
 * reading, the plan allowance (`billing_*`).
 */
export const LimitsConfigSchema = z
  .object({ per_user: PerUserLimitScopeSchema.prefault({}), per_app: AppLimitScopeSchema.prefault({}) })
  .strict();

export type LimitScope = z.output<typeof LimitScopeSchema>;
export type AppLimitScope = z.output<typeof AppLimitScopeSchema>;

/** The app's cap on live sessions of one kind: its own setting, or the default. */
export function appSessionCap(limits: LimitsConfig, kind: keyof typeof APP_SESSION_CAPS): number {
  return limits.per_app.sessions?.[kind] ?? APP_SESSION_CAPS[kind];
}
export type PerUserLimitScope = z.output<typeof PerUserLimitScopeSchema>;
export type LimitsConfig = z.output<typeof LimitsConfigSchema>;

/** Whether a scope sets any limit at all. */
export function scopeHasLimits(scope: LimitScope | PerUserLimitScope): boolean {
  return scope.requests.per_minute !== null || scope.requests.per_day !== null || scope.spending.monthly_nano !== null;
}

/** Whether an app names its end users at all. */
export function identifiesEndUsers(authentication: AuthenticationConfig): boolean {
  return authentication.end_user.source !== "none";
}

/**
 * Whose month the per-user budget is measured over: the configured scope, or
 * by default the Apple Account on an App Attest app and the user on a server
 * app (v1).
 */
export function configuredBudgetScope(authentication: AuthenticationConfig, limits: LimitsConfig): BudgetScope {
  return limits.per_user.spending.scope ?? (authentication.type === "apple_app_attest" ? "apple_account" : "user");
}

/** How long stored conversations are kept, in days: the default, and the bounds an app may set (v1's). */
export const CONVERSATION_RETENTION_DAYS = { default: 180, min: 1, max: 400 } as const;

const keptMedia = (field: string, what: string) =>
  z.boolean({ error: `conversations.keep.${field} must be true or false` }).default(true).meta({
    description: `Keep ${what} beside the conversation. Off, each is recorded by its type and size alone.`,
  });

/**
 * Which attachments a stored conversation keeps: all of them unless the
 * customer leaves a kind out. The conversation itself (messages,
 * instructions, tool calls) is always kept.
 */
const ConversationKeepSchema = z
  .object({
    images: keptMedia("images", "images"),
    audio: keptMedia("audio", "audio: recordings sent for transcription, audio in a request, spoken replies"),
    files: keptMedia("files", "every other attached file, such as a PDF or a text document"),
  })
  .strict();

/**
 * Whether the gateway keeps a copy of this app's calls, and for how long
 * (v1's `conversations`, plan D13 and step 7). Off unless the customer turns
 * it on: what an app's users send is theirs, and keeping it is the
 * customer's decision. Calls only: never a passthrough path, a job or a live
 * session.
 */
export const ConversationsConfigSchema = z
  .object({
    store: z.boolean({ error: "conversations.store must be true or false" }).default(false).meta({
      description: "Keep a copy of every call this app sends through the gateway, request and response, with the media `keep` allows.",
    }),
    keep: ConversationKeepSchema.prefault({}),
    retention_days: z
      .number({ error: "conversations.retention_days must be a whole number of days" })
      .int({ error: "conversations.retention_days must be a whole number of days" })
      .min(CONVERSATION_RETENTION_DAYS.min, { error: `conversations.retention_days must be at least ${CONVERSATION_RETENTION_DAYS.min}` })
      .max(CONVERSATION_RETENTION_DAYS.max, { error: `conversations.retention_days must be at most ${CONVERSATION_RETENTION_DAYS.max}` })
      .default(CONVERSATION_RETENTION_DAYS.default)
      .meta({ description: "Days a stored conversation is kept before it is deleted." }),
  })
  .strict();

export type ConversationsConfig = z.output<typeof ConversationsConfigSchema>;
export type KeptMedia = ConversationsConfig["keep"];

/** Whether a stored `conversations` says nothing its defaults do not, so it is not written (`AGENTS.md`). */
export function conversationsAreDefault(conversations: ConversationsConfig): boolean {
  const { store, keep, retention_days } = conversations;
  return !store && keep.images && keep.audio && keep.files && retention_days === CONVERSATION_RETENTION_DAYS.default;
}

export const AppConfigSchema = z
  .object({
    authentication: AuthenticationConfigSchema,
    routing: RoutingConfigSchema.prefault({}),
    limits: LimitsConfigSchema.prefault({}),
    presets: PresetsConfigSchema.optional(),
    /** Conversation storage (step 7). Written only when it differs from its defaults. */
    conversations: ConversationsConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const { authentication, limits } = config;
    // Per-user limits need somebody to apply to: an app that names no end
    // users caps itself with `per_app` instead.
    if (!identifiesEndUsers(authentication) && scopeHasLimits(limits.per_user)) {
      context.addIssue({
        code: "custom",
        path: ["limits", "per_user"],
        message: "needs an authentication.end_user source other than none: this app names no end users, so use limits.per_app",
      });
    }
    const scope = limits.per_user.spending.scope;
    if (scope !== undefined && authentication.type === "api_key" && scope !== "user") {
      context.addIssue({
        code: "custom",
        path: ["limits", "per_user", "spending", "scope"],
        message: `cannot be ${scope}: server apps have no install or Apple Account; the budget is per user`,
      });
    }
    if (scope === "user" && authentication.type === "apple_app_attest" && authentication.end_user.source !== "issuer") {
      context.addIssue({
        code: "custom",
        path: ["limits", "per_user", "spending", "scope"],
        message: "cannot be user: this App Attest app has no signed-in user; use install or apple_account, or sign users in with an issuer",
      });
    }
  });

export type AppConfig = z.output<typeof AppConfigSchema>;

/** A whole stored `config_json`. Throws `ConfigError` with the first problem. */
export function parseAppConfig(config: unknown): AppConfig {
  const parsed = AppConfigSchema.safeParse(config);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? "" : issue.path.join(".");
  throw new ConfigError(`${where}: ${issue?.message ?? "is invalid"}`);
}

/**
 * A stored `config_json` as the request path reads it: forgiving where saving
 * is strict (`AGENTS.md`). Keys this version does not know, such as ones a
 * later version wrote before a rollback, are dropped and named in
 * `ignoredKeys`; anything else wrong still throws `ConfigError`.
 */
export function parseServedAppConfig(config: unknown): { config: AppConfig; ignoredKeys: string[] } {
  let value: unknown = structuredClone(config);
  const ignoredKeys: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const parsed = AppConfigSchema.safeParse(value);
    if (parsed.success) return { config: parsed.data, ignoredKeys };
    const issues = parsed.error.issues;
    if (!issues.every((issue) => issue.code === "unrecognized_keys")) break;
    for (const issue of issues) {
      let target: unknown = value;
      for (const part of issue.path) target = (target as Record<PropertyKey, unknown> | undefined)?.[part];
      if (typeof target !== "object" || target === null) continue;
      for (const key of (issue as { keys: string[] }).keys) {
        delete (target as Record<string, unknown>)[key];
        ignoredKeys.push([...issue.path.map(String), key].join("."));
      }
    }
  }
  return { config: parseAppConfig(value), ignoredKeys };
}
