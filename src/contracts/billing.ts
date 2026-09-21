/**
 * The billing wire shapes, as one schema per shape.
 *
 * These describe an optional service binding rather than a table this gateway
 * owns, which is why they used to be written three times: as interfaces in
 * `src/billing/contract.ts`, as hand-written types in the console, and a third
 * time as loose `z.unknown()` documentation in `openapi.ts`. Here they are the
 * definition. `src/billing/contract.ts` infers the RPC contract from them,
 * `./catalog.ts` documents and types the seven `/v1/admin/billing` operations
 * with them, and the console imports the inferred types.
 *
 * Plain `zod`, never `@hono/zod-openapi`, for the same reason `./responses.ts`
 * is: the CLI and the console both bundle this file's neighbours, and neither
 * may pull Hono in behind them.
 */
import { z } from "zod";

/** Subscription statuses, as spelled by the billing provider. */
export const BillingSubscriptionStatusSchema = z.enum([
  "on_trial",
  "active",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
]);

export const BillingSourceSchema = z.enum(["lemon_squeezy", "manual"]);

export const BillingPeriodSchema = z.enum(["month", "year"]);

/**
 * The plan an organization is entitled to right now.
 *
 * `limits` is opaque to the billing side and interpreted only by this gateway —
 * see {@link PlanLimitsSchema} and `billingPlanLimits`, which read the whole
 * vocabulary of plan limits out of it. A new ceiling is a new key there and
 * plan data on the billing side; this shape never changes for one.
 */
export const EntitledPlanSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  limits: z.unknown().optional(),
  /** True when it came from the service's default plan rather than a subscription. */
  isDefault: z.boolean(),
}).meta({ id: "EntitledPlan" });

/**
 * What the organization is paying for, reported as stored.
 *
 * Deliberately separate from {@link EntitledPlanSchema}: a subscription that no
 * longer entitles anything still has to be describable, because "your plan
 * ended" is a sentence only this object can support.
 */
export const SubscriptionStateSchema = z.object({
  subscriptionId: z.string().nullable(),
  status: BillingSubscriptionStatusSchema,
  planKey: z.string(),
  planName: z.string(),
  /** Null for trials and manual grants, which carry no price. */
  billingPeriod: BillingPeriodSchema.nullable(),
  renewsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  source: BillingSourceSchema,
  /** This subscription generation */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Original provider day, retained when short months clamp the exact anchor. */
  billingAnchorDay: z.number().nullable(),
  /** Exact normalized UTC origin of the monthly allowance schedule. */
  billingAnchorAt: z.string(),
  /** When the current allowance schedule took effect. */
  billingScheduleUpdatedAt: z.string(),
}).meta({ id: "Subscription" });

/** What the billing service itself answers with for one tenant. */
export const BillingAccessSchema = z.object({
  /** `null` means no entitlement at all, and the gateway refuses the request. */
  plan: EntitledPlanSchema.nullable(),
  /** `null` means the organization has no billing row. */
  subscription: SubscriptionStateSchema.nullable(),
});

/**
 * The billing service's answer, plus the two states only the gateway can be in.
 *
 * `state` is the discriminant the whole gateway and console read: the service
 * itself has no notion of a deployment without billing, nor of its own
 * unreachability, and both have to be distinguishable from "this organization
 * has no plan" — one is unlimited, one is temporary, one is a paywall.
 */
export const GatewayBillingAccessSchema = z.discriminatedUnion("state", [
  /** No `BILLING` binding: self-hosted, unlimited, never refused. */
  z.object({ state: z.literal("self_hosted") }),
  /** The billing RPC failed. The allowance is unknown, so traffic waits. */
  z.object({ state: z.literal("unavailable"), billingErrorCode: z.string().optional() }),
  /** The billing service answered. `plan === null` means no entitlement at all. */
  z.object({
    state: z.literal("billed"),
    plan: EntitledPlanSchema.nullable(),
    subscription: SubscriptionStateSchema.nullable(),
    /**
     * Set when the billing service could not be reached and this is the last
     * reading it gave for the organization. Entitlement decisions are
     * unchanged: a stale `plan === null` is still a paywall.
     */
    stale: z.literal(true).optional(),
    /** Why the refresh failed, on a stale reading. */
    billingErrorCode: z.string().optional(),
  }),
]).meta({ id: "BillingAccess" });

/**
 * What a plan allows, read out of its opaque `limits` JSON.
 *
 * Every limit is a whole count and every one is optional; absent means
 * unlimited, which is what a self-hosted deployment, a plan with no `limits`
 * block, and a plan that simply does not mention the key all get.
 */
export const PlanLimitsSchema = z.object({
  maxRequestsPerMonth: z.number().int().optional()
    .meta({ description: "Requests the account may dispatch per allowance period." }),
  maxApps: z.number().int().optional()
    .meta({ description: "Applications the account may own." }),
  maxProviders: z.number().int().optional()
    .meta({ description: "Providers the account may own." }),
  maxProviderGateways: z.number().int().optional()
    .meta({ description: "Provider gateways the account may own." }),
  maxActiveKeysPerApp: z.number().int().optional()
    .meta({ description: "Active API keys each of the account's applications may hold." }),
}).meta({
  description:
    "The plan's ceilings, as this gateway enforces them. Every key is optional and an absent key means unlimited, so an empty object is a plan with no ceilings. A write that would exceed one is refused with billing_plan_limit_reached.",
});

/**
 * The organization's current monthly allowance period against the one allowance
 * a plan grants. Only the dispatch path writes this count, so a status read is
 * the only place an operator can see it before the allowance runs out.
 */
export const OrganizationQuotaStatusSchema = z.object({
  periodId: z.string().meta({ description: "Opaque identifier for the allowance period being reported." }),
  periodStart: z.string().meta({ description: "Inclusive UTC instant at which this allowance period began." }),
  periodEnd: z.string().meta({ description: "Exclusive UTC instant at which this allowance period ends." }),
  used: z.number().int().meta({ description: "Requests dispatched to a provider in this period, across all apps." }),
  limit: z.number().int().optional().meta({ description: "The plan's maxRequestsPerMonth. Absent means unlimited." }),
  resetAt: z.string().meta({ description: "UTC instant at which the allowance resets; currently equal to periodEnd." }),
});

export const BillingStatusResponseSchema = z.object({
  access: GatewayBillingAccessSchema,
  limits: PlanLimitsSchema,
  quota: OrganizationQuotaStatusSchema.nullable().meta({
    description: "Null when billing is unavailable or no plan entitlement resolves.",
  }),
});

export const BillingPlanOfferPriceSchema = z.object({
  billingPeriod: BillingPeriodSchema,
  priceAmountCents: z.number(),
  priceCurrency: z.string(),
});

export const BillingPlanOfferSchema = z.object({
  planKey: z.string(),
  name: z.string(),
  description: z.string(),
  features: z.array(z.string()),
  limits: z.unknown().optional(),
  trialDays: z.number(),
  prices: z.array(BillingPlanOfferPriceSchema),
}).meta({ id: "BillingPlan" });

export const BillingPlansResponseSchema = z.object({
  plans: z.array(BillingPlanOfferSchema),
});

/** The plan and period a purchase, change or resume names. */
export const BillingPlanSelectionSchema = z.object({
  planKey: z.string().min(1),
  billingPeriod: BillingPeriodSchema,
});

export const BillingCheckoutRequestSchema = BillingPlanSelectionSchema.extend({
  successUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
});

export const BillingCheckoutResponseSchema = z.object({ url: z.string() });

/**
 * What a subscription change or resume answers with. `requiredActionUrl` is the
 * provider page a payment method has to be confirmed on before it takes effect.
 */
export const BillingChangeResponseSchema = z.object({
  ok: z.literal(true),
  requiredActionUrl: z.string().optional(),
});

export const BillingCancelResponseSchema = z.object({ ok: z.literal(true) });

export const BillingTrialRequestSchema = z.object({ planKey: z.string().min(1) });

/** The same three vocabularies as arrays, for callers that enumerate them. */
export const billingSubscriptionStatuses = BillingSubscriptionStatusSchema.options;
export const billingSources = BillingSourceSchema.options;
export const billingPeriods = BillingPeriodSchema.options;

export type BillingSubscriptionStatus = z.infer<typeof BillingSubscriptionStatusSchema>;
export type BillingSource = z.infer<typeof BillingSourceSchema>;
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;
export type EntitledPlan = z.infer<typeof EntitledPlanSchema>;
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;
export type BillingAccess = z.infer<typeof BillingAccessSchema>;
export type GatewayBillingAccess = z.infer<typeof GatewayBillingAccessSchema>;
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
export type OrganizationQuotaStatus = z.infer<typeof OrganizationQuotaStatusSchema>;
export type BillingStatusResponse = z.infer<typeof BillingStatusResponseSchema>;
export type BillingPlanOfferPrice = z.infer<typeof BillingPlanOfferPriceSchema>;
export type BillingPlanOffer = z.infer<typeof BillingPlanOfferSchema>;
export type BillingPlansResponse = z.infer<typeof BillingPlansResponseSchema>;
export type BillingPlanSelection = z.infer<typeof BillingPlanSelectionSchema>;
export type BillingCheckoutRequest = z.infer<typeof BillingCheckoutRequestSchema>;
export type BillingCheckoutResponse = z.infer<typeof BillingCheckoutResponseSchema>;
export type BillingChangeResponse = z.infer<typeof BillingChangeResponseSchema>;
export type BillingCancelResponse = z.infer<typeof BillingCancelResponseSchema>;
export type BillingTrialRequest = z.infer<typeof BillingTrialRequestSchema>;
