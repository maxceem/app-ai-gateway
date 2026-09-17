import { z } from "zod";
import { ProviderGatewaySummarySchema, ProviderSummarySchema } from "./responses.ts";
export const CliProofSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
export const CliBootstrapRequestSchema = z
  .object({ idempotencyKey: CliProofSchema, pollToken: CliProofSchema })
  .strict();
export const CliOperationRequestSchema = z
  .object({
    kind: z.enum([
      "claim",
      "provider.add",
      "provider.rotate-key",
      "provider.update",
      "provider-gateway.add",
      "provider-gateway.rotate-key",
    ]),
    payload: z.record(z.string(), z.unknown()).default({}),
    pollToken: CliProofSchema,
  })
  .strict();
export const CliSubmissionRequestSchema = z
  .object({
    submissionToken: CliProofSchema,
    approve: z.literal(true).optional(),
    email: z.email().optional(),
    password: z.string().min(8).max(256).optional(),
    name: z.string().min(1).max(100).optional(),
    secret: z.string().max(16384).optional(),
  })
  .strict();

export const CliDeploymentSchema = z.object({
  id: z.string(),
  mode: z.enum(["cloud", "self_hosted"]),
  apiUrl: z.url(),
  consoleOrigin: z.url(),
});
export const CliAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  claimed: z.boolean(),
  expiresAt: z.string().nullable(),
});
/** Who this browser would approve as: the interactive human holding the session. */
export const CliViewerSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
});
/**
 * What the console's approval page reads before it shows anything.
 *
 * The page is the human half of a browser handoff, so it is told only what a
 * person needs in order to recognize the request they started in a terminal:
 * the action, the resource configuration the CLI sent, the account it lands on,
 * and the human this browser would approve as, which is null when nobody is
 * signed in. No secret, submitted or stored, is ever part of it.
 */
export const CliBrowserDetailsResponseSchema = z.object({
  kind: CliOperationRequestSchema.shape.kind,
  payload: z.record(z.string(), z.unknown()),
  account: CliAccountSchema,
  viewer: CliViewerSchema.nullable(),
  googleEnabled: z.boolean(),
  expiresAt: z.string(),
});
/** The terminal state a completed approval leaves the page in. */
export const CliBrowserSubmitResponseSchema = z.object({
  state: z.literal("completed"),
  message: z.string(),
});
/**
 * Better Auth's own sign-up answer, relayed verbatim by the claim-registration
 * endpoint. Only the fields the page could act on are named; the session it
 * really returns is a cookie, not a body.
 */
export const CliBrowserRegisterResponseSchema = z.object({
  token: z.string().nullable().optional(),
  redirect: z.boolean().optional(),
});
/** Where to send the browser to start Google consent for a claim. */
export const CliBrowserGoogleResponseSchema = z.object({
  url: z.string(),
  redirect: z.boolean().optional(),
});

/** Management keys never expire; the account's own deadline is the only one. */
export const CliCredentialSchema = z.object({
  token: z.string(),
});
export const CliBootstrapResponseSchema = z.object({
  deployment: CliDeploymentSchema,
  account: CliAccountSchema,
  credential: CliCredentialSchema,
  trial: z.object({ endsAt: z.string(), limit: z.number().int().optional() }).nullable(),
});
export const CliOperationResponseSchema = z.object({
  id: z.string(),
  url: z.url(),
  expiresAt: z.string(),
  state: z.enum(["pending", "completed", "failed", "expired"]),
  deployment: CliDeploymentSchema,
});
/**
 * What a completed browser handoff leaves behind for the CLI to print.
 *
 * Declared field by field rather than passed through. The gateway records its
 * own outcome for each kind of handoff, and those records carry more than the
 * caller has any business seeing: a completed claim also holds the approving
 * human's user id and the internal compare-and-swap marker that decided which
 * concurrent submission won. Naming the publishable fields here is what keeps
 * the rest off the CLI's stdout, because zod drops what a schema does not
 * declare — the job the CLI's hand-written field allow-list used to do.
 */
export const CliOperationResultSchema = z.object({
  /** The account a claim acted on. */
  accountId: z.string().optional(),
  /** The stored row a provider submission created or rotated. */
  provider: ProviderSummarySchema.optional(),
  gateway: ProviderGatewaySummarySchema.optional(),
});

export const CliPollResponseSchema = z.object({
  id: z.string(),
  expiresAt: z.string(),
  deployment: CliDeploymentSchema,
  state: z.enum(["pending", "completed", "failed", "expired"]),
  result: CliOperationResultSchema.optional(),
  account: CliAccountSchema.nullable().optional(),
});
export const CliUsageTotalsSchema = z.object({
  requests: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  errors: z.number(),
  blocked: z.number(),
});
export const CliUsageResponseSchema = z.object({
  accountId: z.string(),
  month: z.string(),
  totals: CliUsageTotalsSchema,
  apps: z.array(
    CliUsageTotalsSchema.extend({
      appId: z.string(),
      deleted: z.boolean(),
      firstRecord: z.string(),
    }),
  ),
  coverage: z.object({
    scope: z.literal("retained_account_usage"),
    firstRecord: z.string().nullable(),
    historicalAttribution: z.string(),
  }),
});
export const CliCapabilitiesResponseSchema = z.object({
  protocolVersion: z.literal(1),
  serverVersion: z.string(),
  deployment: CliDeploymentSchema,
  consoleOrigin: z.url(),
  providers: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      defaultPath: z.string().optional(),
      apiStyles: z.array(z.string()),
      endpointStyles: z.array(z.string()),
    }),
  ),
  providerGateways: z.array(z.object({ type: z.string(), name: z.string() })),
});

/**
 * What `GET /v1/cli/account` answers with.
 *
 * `billing` and `usage` are declared field by field rather than passed through,
 * because the CLI prints this verbatim on stdout: the resolution it is built
 * from also carries the internal schedule identity (`scheduleId`,
 * `scheduleRevision`) and the `superseded` marker, none of which is any of the
 * caller's business. Parsing against this schema is what keeps them off stdout,
 * which is the job the CLI's hand-written field allow-list used to do.
 */
export const CliEntitledPlanSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  isDefault: z.boolean(),
});
export const CliSubscriptionSchema = z.object({
  subscriptionId: z.string().nullable(),
  status: z.string(),
  planKey: z.string(),
  planName: z.string(),
  billingPeriod: z.enum(["month", "year"]).nullable(),
  renewsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  billingAnchorDay: z.number().nullable(),
  billingAnchorAt: z.string(),
  billingScheduleUpdatedAt: z.string(),
});
export const CliBillingAccessSchema = z.object({
  state: z.string(),
  plan: CliEntitledPlanSchema.nullable().optional(),
  subscription: CliSubscriptionSchema.nullable().optional(),
});
export const CliBillingSchema = z.object({
  access: CliBillingAccessSchema,
  limit: z.number().optional(),
  period: z.object({
    periodId: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    resetAt: z.string(),
  }).optional(),
});
/** `{}` while a period is superseded, and null outside a billed plan. */
export const CliQuotaUsageSchema = z.object({
  periodId: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  resetAt: z.string().optional(),
  used: z.number().optional(),
}).nullable();
export const CliAccountResponseSchema = z.object({
  deployment: CliDeploymentSchema,
  account: CliAccountSchema,
  billing: CliBillingSchema,
  usage: CliQuotaUsageSchema,
});

export type CliDeployment = z.infer<typeof CliDeploymentSchema>;
export type CliAccount = z.infer<typeof CliAccountSchema>;
export type CliCredential = z.infer<typeof CliCredentialSchema>;
export type CliBootstrapResponse = z.infer<typeof CliBootstrapResponseSchema>;
export type CliOperationResponse = z.infer<typeof CliOperationResponseSchema>;
export type CliPollResponse = z.infer<typeof CliPollResponseSchema>;
export type CliOperationResult = z.infer<typeof CliOperationResultSchema>;
export type CliUsageResponse = z.infer<typeof CliUsageResponseSchema>;
export type CliCapabilitiesResponse = z.infer<typeof CliCapabilitiesResponseSchema>;
export type CliAccountResponse = z.infer<typeof CliAccountResponseSchema>;
export type CliBootstrapRequest = z.infer<typeof CliBootstrapRequestSchema>;
export type CliOperationRequest = z.infer<typeof CliOperationRequestSchema>;
export type CliSubmissionRequest = z.infer<typeof CliSubmissionRequestSchema>;
export type CliBrowserDetailsResponse = z.infer<typeof CliBrowserDetailsResponseSchema>;
export type CliBrowserSubmitResponse = z.infer<typeof CliBrowserSubmitResponseSchema>;
export type CliBrowserRegisterResponse = z.infer<typeof CliBrowserRegisterResponseSchema>;
export type CliBrowserGoogleResponse = z.infer<typeof CliBrowserGoogleResponseSchema>;
export type CliOperationKind = CliOperationRequest["kind"];
