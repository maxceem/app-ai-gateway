import { z } from "zod";
import {
  AppResponseSchema,
  CreatedApiKeySchema,
  OrganizationSummarySchema,
  ProviderGatewaySummarySchema,
  ProviderSummarySchema,
  UsageTotalsSchema,
} from "./responses.ts";
import {
  ApiKeyCreateRequestSchema,
  AppWriteSchema,
  HandoffProviderAddPayloadSchema,
  HandoffProviderGatewayAddPayloadSchema,
  HandoffProviderUpdatePayloadSchema,
  HandoffRotatePayloadSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
} from "./schemas.ts";
import { EntitledPlanSchema, GatewayBillingAccessSchema } from "./billing.ts";
/** The one random secret a CLI operation is proven with; its digest is the operation's id. */
export const CliProofSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
export const CliBootstrapRequestSchema = z.object({ token: CliProofSchema }).strict();
/**
 * The short code a terminal shows beside an approval link, for a person who
 * would rather type it than follow the link: eight characters, the dash
 * optional, case ignored.
 */
export const CliUserCodeSchema = z.string().regex(/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/);
/**
 * What a browser step is addressed with: the proof from the approval URL's
 * fragment, or the user code the terminal shows. The two never overlap, since a
 * proof is at least 32 characters long. Flag-free, because the source is
 * published verbatim as an OpenAPI `pattern`.
 */
export const CliSubmissionTokenSchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{32,256}|[A-Za-z0-9]{4}-?[A-Za-z0-9]{4})$/);

/**
 * Every kind of CLI operation. `bootstrap` and `login` have endpoints of their
 * own because they are the two that need no credential; every other kind is
 * sent to `/v1/cli/operations`. All of them are polled the same way.
 */
export const CliOperationKindSchema = z.enum([
  "bootstrap",
  "login",
  "claim",
  "app.add",
  "app.key.add",
  "provider.add",
  "provider.update",
  "provider.rotate-key",
  "provider-gateway.add",
  "provider-gateway.rotate-key",
]);

/** The kinds a client sends to `/v1/cli/operations`. */
export type CliRequestedOperationKind = Exclude<z.infer<typeof CliOperationKindSchema>, "bootstrap" | "login">;

/** A key for an existing application: the key's own fields, and the application it belongs to. */
export const CliAppKeyAddPayloadSchema = ApiKeyCreateRequestSchema.extend({ app: z.string().min(1) }).strict();

/**
 * One member per kind, each with the payload that kind's write takes. A kind
 * whose secret may be supplied in a browser instead takes `browser: true` and
 * the payload without it; the kinds that edit a secret always ask the browser
 * for it. Checked when the operation is sent, so a malformed request is
 * refused in the terminal that sent it rather than on the approval page.
 */
function operationRequest<
  const Kind extends CliRequestedOperationKind,
  Payload extends z.ZodType,
>(kind: Kind, payload: Payload, browser: "never" | "optional" | "always") {
  const fields = { kind: z.literal(kind), payload, token: CliProofSchema };
  return browser === "optional"
    ? z.object({ ...fields, browser: z.literal(true).optional() }).strict()
    : z.object(fields).strict();
}

export const CliOperationRequestSchema = z.discriminatedUnion("kind", [
  operationRequest("claim", z.object({}).strict().default({}), "always"),
  operationRequest("app.add", AppWriteSchema, "never"),
  operationRequest("app.key.add", CliAppKeyAddPayloadSchema, "never"),
  operationRequest("provider.add", z.union([ProviderCreateRequestSchema, HandoffProviderAddPayloadSchema]), "optional"),
  operationRequest("provider.update", HandoffProviderUpdatePayloadSchema, "always"),
  operationRequest("provider.rotate-key", HandoffRotatePayloadSchema, "always"),
  operationRequest(
    "provider-gateway.add",
    z.union([ProviderGatewayCreateRequestSchema, HandoffProviderGatewayAddPayloadSchema]),
    "optional",
  ),
  operationRequest("provider-gateway.rotate-key", HandoffRotatePayloadSchema, "always"),
]);
/**
 * What every browser endpoint is sent: the proof from the approval URL's
 * fragment, or the user code the terminal shows. Only a login issues a user
 * code; a claim and a provider step are reached through their link alone.
 */
export const CliBrowserProofSchema = z.object({ submissionToken: CliSubmissionTokenSchema }).strict();
/**
 * The approval itself. The secret is what a provider or gateway step asks its
 * approver for; whether a kind requires one is the kind's own rule.
 * `organizationId` is which of the approver's accounts a login lands in, and
 * may be left out when they belong to exactly one.
 */
export const CliBrowserSubmitRequestSchema = z
  .object({
    submissionToken: CliSubmissionTokenSchema,
    approve: z.literal(true),
    // Flag-free, because the source is published verbatim as an OpenAPI `pattern`.
    secret: z.string().max(16384).regex(/\S/, { error: "must not be blank" }).optional(),
    organizationId: z.string().min(1).max(256).optional(),
  })
  .strict();
/** The sign-in a claim's or a login's approver creates, when they have none here yet. */
export const CliBrowserRegisterRequestSchema = z
  .object({
    submissionToken: CliSubmissionTokenSchema,
    email: z.email(),
    password: z.string().min(8).max(256),
    name: z.string().min(1).max(100),
  })
  .strict();

export const CliDeploymentSchema = z.object({
  id: z.string(),
  mode: z.enum(["cloud", "self_hosted"]),
  apiUrl: z.url(),
  consoleOrigin: z.url(),
});
/**
 * What has to happen before this handoff can be approved.
 *
 * Only a claim and a login ever report one. Every other handoff is authorised
 * by the proof in the URL and the CLI credential that opened it, so it asks
 * nothing at all of whoever is holding the browser. A claim is an exception
 * because it settles an unowned account on its first person, and a login
 * because it gives a CLI a key belonging to the person who approves it.
 *
 * `registration_required` is never "sign in" for a claim, and that is the
 * point rather than an omission: arriving with a sign-in that already has an
 * account is precisely what a claim refuses, so a page that offered one would
 * be offering the way in that `sign_out_required` exists to close. A login has
 * no such rule — belonging to other accounts is what a login is for, and
 * `sign_out_required` is a claim's alone — so a login's page may offer signing
 * in beside registering.
 */
export const CliApprovalRefusalSchema = z.enum([
  "registration_required",
  "sign_out_required",
  /**
   * A login's approver belongs to no account they could log the CLI in to, and
   * this deployment does not give a person one of their own. Nothing on the
   * page can fix that; an owner has to add them to an account first.
   */
  "no_eligible_organization",
]);
/** Who this browser would approve as: the interactive human holding the session. */
export const CliViewerSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
});
/** What a CLI said about itself when it asked for a login. Shown, never trusted. */
export const CliOperationClientSchema = z.object({
  /** E.g. `CLI on mac-studio`. */
  label: z.string().nullable(),
  os: z.string().nullable(),
  /** The address the request came from, as the edge saw it. */
  ip: z.string().nullable(),
  requestedAt: z.string(),
});
/** One account a login's approver may log the CLI in to. */
export const CliLoginOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member"]),
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
  kind: CliOperationKindSchema,
  payload: z.record(z.string(), z.unknown()),
  /** Null only for a login, which lands in whichever account its approver picks. */
  account: OrganizationSummarySchema.nullable(),
  viewer: CliViewerSchema.nullable(),
  /**
   * What stands between this browser and the Approve button, or null when
   * nothing does — which is every kind but a claim and a login, since only
   * those two ask who is holding the browser. One field decides the whole screen: each value
   * names the single thing the page may offer, so the page never has to
   * consult the handoff kind to know what to put in front of a person.
   */
  blockedBy: CliApprovalRefusalSchema.nullable(),
  googleEnabled: z.boolean(),
  expiresAt: z.string(),
  /**
   * The code the terminal shows, however the page was reached, so a person
   * can check it against their terminal before approving. Null for a kind
   * that has none — every kind but a login.
   */
  userCode: z.string().nullable(),
  /** Who asked, for a login; null for every other kind. */
  client: CliOperationClientSchema.nullable(),
  /** Whether approving hands the browser back to the CLI's local listener (`redirectUrl`). */
  hasLoopbackRedirect: z.boolean(),
  /**
   * For a login only: the accounts the signed-in person may log the CLI in to,
   * so the page can ask which one when there is more than one.
   */
  organizations: z.array(CliLoginOrganizationSchema).optional(),
});
/**
 * Where the person who approved a handoff goes next.
 *
 * A handoff is started in a terminal, so `cli` is the answer for all but one
 * kind: the command that opened the browser is still waiting, and the browser
 * has nothing left to offer. A `claim` is the exception, because approving it
 * is also the moment its approver gets a console: they created their sign-in on
 * the approval page seconds earlier, so this browser now holds a session on the
 * very account the CLI just settled, and sending them back to a terminal would
 * hide the thing they just gained.
 *
 * Decided by the gateway rather than by the page, for the same reason
 * `blockedBy` is: the handoff kinds and what each one leaves behind are the
 * gateway's knowledge, and a page that mapped kinds to endings itself would be
 * a second copy of that table, free to disagree with the first.
 */
export const CliHandoffContinuationSchema = z.enum(["cli", "console"]);
/** The terminal state a completed approval leaves the page in. */
export const CliBrowserSubmitResponseSchema = z.object({
  state: z.literal("completed"),
  /** The whole of what the page says once it is approved. */
  message: z.string(),
  continueTo: CliHandoffContinuationSchema,
  /**
   * Set when the CLI registered a local listener: the page navigates here, and
   * the one-time code in it is what the CLI redeems for its credential.
   */
  redirectUrl: z.url().optional(),
});
/** A browser step someone holding its link declined. The CLI's next poll reports it. */
export const CliBrowserDenyResponseSchema = z.object({
  state: z.literal("denied"),
  message: z.string(),
});
/** A code a person typed on the console's code-entry page. */
export const CliBrowserLookupRequestSchema = z.object({ userCode: z.string().min(1).max(32) }).strict();
/** The pending step a typed code names; carry on with the code as `submissionToken`. */
export const CliBrowserLookupResponseSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    id: z.string(),
    kind: CliOperationKindSchema,
    expiresAt: z.string(),
  }),
]);
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
/**
 * A CLI that holds no credential asking a person for one. `token` is the
 * operation's random secret, saved before sending exactly as for every other
 * operation; `loopbackRedirect` is where the approval page sends the browser
 * when the CLI listens locally, and then the credential is released only to
 * `redeemCliLogin`, never to a poll.
 */
export const CliLoginRequestSchema = z
  .object({
    token: CliProofSchema,
    client: z
      .object({
        label: z.string().trim().min(1).max(200),
        os: z.string().trim().min(1).max(64).optional(),
      })
      .strict(),
    // Ports 1–65535, spelled out because the source is published as an
    // OpenAPI `pattern` and has no range syntax.
    loopbackRedirect: z
      .string()
      .regex(
        /^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])\/callback$/,
      )
      .optional(),
  })
  .strict();
/**
 * An opened login. `url` and `userCode` are present while it is pending: the
 * CLI opens the one and prints the other, so a person can either follow the
 * link or type the code on the console's code-entry page.
 */
export const CliLoginSchema = z.object({
  id: z.string(),
  kind: z.literal("login"),
  /** `completed` when a login already approved is sent again: poll it, or redeem it, for the key. */
  state: z.enum(["pending", "completed", "denied", "expired"]),
  url: z.url().nullable(),
  userCode: z.string().nullable(),
  expiresAt: z.string(),
});
/** The one-time code the approval page handed the CLI's local listener. */
export const CliLoginRedeemRequestSchema = z.object({ redeemCode: CliProofSchema }).strict();
/** A login's credential and the account it was approved into. Never print or log the credential. */
export const CliLoginRedeemResponseSchema = z.object({
  credential: CliCredentialSchema,
  account: OrganizationSummarySchema,
});
/** The management key the caller authenticated with, revoked. */
export const CliCredentialRevokeResponseSchema = z.object({ revoked: z.literal(true) });
const UnclaimedAccessSchema = z
  .object({ endsAt: z.string(), limit: z.number().int().optional() })
  .nullable();

/**
 * What a completed operation leaves behind for the CLI to print.
 *
 * Declared field by field rather than passed through. The gateway records its
 * own outcome for each kind, and those records carry more than the caller has
 * any business seeing: a completed claim also holds the user id of the human
 * who approved it. Naming the publishable fields here is what keeps the rest
 * off the CLI's stdout, because zod drops what a schema does not declare.
 *
 * A one-time secret — a bootstrap's management key, a new application key —
 * is here only while the operation still holds it sealed.
 */
export const CliOperationResultSchema = z.object({
  /** A bootstrap's or a login's management key. Never print or log it. */
  credential: CliCredentialSchema.optional(),
  /**
   * On a hosted deployment, when a bootstrapped account's free access ends and
   * the request allowance it has until then; null on a self-host.
   */
  unclaimedAccess: UnclaimedAccessSchema.optional(),
  /** The account a claim acted on, or a login landed in. */
  accountId: z.string().optional(),
  app: AppResponseSchema.shape.app.optional(),
  /**
   * The application key an `app.add` or `app.key.add` created. `key` is its
   * plaintext, present only while the operation still holds it sealed.
   */
  api_key: CreatedApiKeySchema.partial({ key: true }).nullable().optional(),
  provider: ProviderSummarySchema.optional(),
  gateway: ProviderGatewaySummarySchema.optional(),
});

/**
 * Where one operation stands, as both sending it and polling it answer. `url`
 * is the approval page while a browser step is owed; `result` arrives once it
 * has completed.
 */
export const CliOperationSchema = z.object({
  id: z.string(),
  kind: CliOperationKindSchema,
  state: z.enum(["pending", "completed", "expired"]),
  /** Set beside `state: "expired"` when a person declined the browser step rather than letting it lapse. */
  denied: z.literal(true).optional(),
  expiresAt: z.string(),
  url: z.url().optional(),
  deployment: CliDeploymentSchema,
  result: CliOperationResultSchema.optional(),
  account: OrganizationSummarySchema.nullable().optional(),
});
export const CliUsageResponseSchema = z.object({
  accountId: z.string(),
  month: z.string(),
  totals: UsageTotalsSchema,
  apps: z.array(
    UsageTotalsSchema.extend({
      appId: z.string(),
      deleted: z.boolean(),
      firstRecord: z.string(),
    }),
  ),
  coverage: z.object({
    scope: z.literal("retained_account_usage"),
    firstRecord: z.string().nullable(),
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
  /** What this deployment supports beyond protocol 1's baseline. Absent on older deployments. */
  features: z
    .object({
      /** `POST /v1/cli/login`: a person approves a CLI in a browser and it receives a key of its own. */
      browserLogin: z.boolean(),
    })
    .optional(),
});

const [SelfHostedAccessSchema, UnavailableAccessSchema, BilledAccessSchema] =
  GatewayBillingAccessSchema.options;

/**
 * The access `GET /v1/cli/account` reports: the gateway's own answer, less what
 * a terminal has no use for — a plan's opaque `limits`, a stale reading's
 * marker and the billing service's error code.
 */
export const CliBillingAccessSchema = z.discriminatedUnion("state", [
  SelfHostedAccessSchema,
  UnavailableAccessSchema.pick({ state: true }),
  BilledAccessSchema.pick({ state: true, subscription: true }).extend({
    plan: EntitledPlanSchema.omit({ limits: true }).nullable(),
  }),
]);
/** Null outside a billed plan, and for a plan with no monthly limit, which counts nothing. */
export const CliQuotaUsageSchema = z.object({
  periodId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  resetAt: z.string(),
  used: z.number(),
  limit: z.number(),
}).nullable();
/**
 * What `GET /v1/cli/account` answers with.
 *
 * `billing` and `usage` are declared field by field rather than passed through,
 * because the CLI prints this verbatim on stdout: parsing against this schema
 * is what keeps anything the resolution carries beyond them off it.
 */
export const CliAccountResponseSchema = z.object({
  deployment: CliDeploymentSchema,
  account: OrganizationSummarySchema,
  billing: z.object({ access: CliBillingAccessSchema }),
  usage: CliQuotaUsageSchema,
});

export type CliDeployment = z.infer<typeof CliDeploymentSchema>;
export type CliCredential = z.infer<typeof CliCredentialSchema>;
export type CliOperation = z.infer<typeof CliOperationSchema>;
export type CliOperationResult = z.infer<typeof CliOperationResultSchema>;
export type CliUsageResponse = z.infer<typeof CliUsageResponseSchema>;
export type CliCapabilitiesResponse = z.infer<typeof CliCapabilitiesResponseSchema>;
export type CliAccountResponse = z.infer<typeof CliAccountResponseSchema>;
export type CliBootstrapRequest = z.infer<typeof CliBootstrapRequestSchema>;
export type CliOperationRequest = z.infer<typeof CliOperationRequestSchema>;
export type CliBrowserProof = z.infer<typeof CliBrowserProofSchema>;
export type CliBrowserSubmitRequest = z.infer<typeof CliBrowserSubmitRequestSchema>;
export type CliBrowserRegisterRequest = z.infer<typeof CliBrowserRegisterRequestSchema>;
export type CliApprovalRefusal = z.infer<typeof CliApprovalRefusalSchema>;
export type CliBrowserDetailsResponse = z.infer<typeof CliBrowserDetailsResponseSchema>;
export type CliHandoffContinuation = z.infer<typeof CliHandoffContinuationSchema>;
export type CliBrowserSubmitResponse = z.infer<typeof CliBrowserSubmitResponseSchema>;
export type CliBrowserRegisterResponse = z.infer<typeof CliBrowserRegisterResponseSchema>;
export type CliBrowserGoogleResponse = z.infer<typeof CliBrowserGoogleResponseSchema>;
export type CliBrowserDenyResponse = z.infer<typeof CliBrowserDenyResponseSchema>;
export type CliBrowserLookupResponse = z.infer<typeof CliBrowserLookupResponseSchema>;
export type CliOperationClient = z.infer<typeof CliOperationClientSchema>;
export type CliLoginOrganization = z.infer<typeof CliLoginOrganizationSchema>;
export type CliLoginRequest = z.infer<typeof CliLoginRequestSchema>;
export type CliLogin = z.infer<typeof CliLoginSchema>;
export type CliLoginRedeemResponse = z.infer<typeof CliLoginRedeemResponseSchema>;
export type CliOperationKind = z.infer<typeof CliOperationKindSchema>;
export type CliOperationRequestInput = z.input<typeof CliOperationRequestSchema>;
/** The payload an operation of one kind carries, as a client writes it. */
export type CliOperationPayload<Kind extends CliRequestedOperationKind> = NonNullable<
  Extract<CliOperationRequestInput, { kind: Kind }>["payload"]
>;
