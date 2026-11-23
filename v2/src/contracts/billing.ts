/**
 * The hosted billing service's wire shapes, and the plan limits this gateway
 * reads out of a plan.
 *
 * Ported from v1's `src/contracts/billing.ts`: what the request path reads,
 * and the billing operations the console's billing page uses. The billing service is an optional service binding (`BILLING`):
 * a self-hosted deployment has none and has no plan allowance.
 *
 * Plain `zod`, as every contract module, so clients can import it.
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
 * The plan an account is entitled to right now. `limits` is opaque to the
 * billing side and read only by this gateway (`PlanLimitsSchema`): a new
 * ceiling is a new key there and plan data on the billing side, never a change
 * to this shape.
 */
export const EntitledPlanSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  limits: z.unknown().optional(),
  /** True when it came from the service's default plan rather than a subscription. */
  isDefault: z.boolean(),
});

/** What the account is paying for, as the billing service stores it. */
export const SubscriptionStateSchema = z.object({
  subscriptionId: z.string().nullable(),
  status: BillingSubscriptionStatusSchema,
  planKey: z.string(),
  planName: z.string(),
  billingPeriod: BillingPeriodSchema.nullable(),
  renewsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  source: BillingSourceSchema,
  /** This subscription generation. A new one starts a new allowance counter. */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The provider's renewal day, kept when a short month clamps the anchor. */
  billingAnchorDay: z.number().nullable(),
  /** The exact UTC origin of the subscription's monthly schedule. */
  billingAnchorAt: z.string(),
  billingScheduleUpdatedAt: z.string(),
});

/** What the billing service answers for one tenant. */
export const BillingAccessSchema = z.object({
  /** `null`: no entitlement at all, and app traffic is refused with 402. */
  plan: EntitledPlanSchema.nullable(),
  subscription: SubscriptionStateSchema.nullable(),
});

/**
 * The billing service's answer, plus the two states only the gateway can be
 * in: no billing service at all (self-hosted, unlimited), and a billing
 * service that could not be read (temporary; app traffic is served).
 */
export const GatewayBillingAccessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("self_hosted") }),
  z.object({ state: z.literal("unavailable"), billingErrorCode: z.string().optional() }),
  z.object({
    state: z.literal("billed"),
    plan: EntitledPlanSchema.nullable(),
    subscription: SubscriptionStateSchema.nullable(),
    /** The last reading the service gave, served while it cannot be reached. */
    stale: z.literal(true).optional(),
    billingErrorCode: z.string().optional(),
  }),
]);

/**
 * What a plan allows, read out of its opaque `limits` JSON. Every limit is a
 * whole count and every one is optional: absent means unlimited.
 *
 * `maxRequestsPerMonth` and `maxSessionMinutesPerMonth` are spent on the
 * request path, per plan period. `maxApps`, `maxProviders` and
 * `maxActiveKeysPerApp` are ceilings on stored settings, checked when an app,
 * a provider connection or an app key is created (v1's keys, without
 * `maxProviderGateways`: v2 has no gateway objects, D13).
 *
 * This is the plan allowance an account pays for. It never caps, and is never
 * read by, the limits an app sets on its own end users (`app_*`).
 */
export const PlanLimitsSchema = z.object({
  maxRequestsPerMonth: z.number().int().optional()
    .meta({ description: "Requests the account may send to providers per plan period." }),
  maxSessionMinutesPerMonth: z.number().int().optional()
    .meta({ description: "Live session minutes the account may use per plan period. Enforced once live sessions exist." }),
  maxApps: z.number().int().optional().meta({ description: "Apps the account may have." }),
  maxProviders: z.number().int().optional().meta({ description: "Provider connections the account may have, disabled ones included." }),
  maxActiveKeysPerApp: z.number().int().optional().meta({ description: "Active app keys one app may have." }),
});

/** Every plan limit key this gateway reads. */
export const PLAN_LIMIT_KEYS = [
  "maxRequestsPerMonth",
  "maxSessionMinutesPerMonth",
  "maxApps",
  "maxProviders",
  "maxActiveKeysPerApp",
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/**
 * One plan limit as plan data may carry it. JSON has no integer type, so
 * `10000`, `10000.0` and `"10000"` mean the same; a fraction, a negative, a
 * boolean, `null`, an object or an empty string is not a count.
 */
export const PlanLimitInputSchema = z.union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().int().nonnegative())
  .optional();

/**
 * The features a plan can include or leave out, as a list of names under
 * `limits.includes` (v1's rule: no list means every feature). Renaming one is
 * a breaking change for every plan that lists it.
 */
export const PLAN_FEATURES = ["conversationStorage"] as const;
export const PlanFeatureSchema = z.enum(PLAN_FEATURES);

/** Whether the account's plan includes each feature, as the gateway decides it. */
export const PlanFeatureAccessSchema = z.object(
  Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, z.boolean()])) as Record<(typeof PLAN_FEATURES)[number], z.ZodBoolean>,
);

/**
 * The current plan period against the plan's request allowance. Only the
 * request path writes this count, so this is where a person sees it before
 * the allowance runs out.
 */
export const PlanAllowanceSchema = z.object({
  periodId: z.string().meta({ description: "The period: the plan's schedule and the period's start." }),
  periodStart: z.string().meta({ description: "When this period began (UTC, inclusive)." }),
  periodEnd: z.string().meta({ description: "When this period ends (UTC, exclusive)." }),
  used: z.number().int().meta({ description: "Requests sent to providers in this period, across all apps." }),
  limit: z.number().int().meta({ description: "The plan's maxRequestsPerMonth." }),
  resetAt: z.string().meta({ description: "When the allowance resets; the same as periodEnd." }),
});

/** What a person may do about the subscription, decided here so no client restates the billing provider's rules. */
export const SubscriptionActionsSchema = z.object({
  cancel: z.boolean().meta({ description: "A self-service subscription can be cancelled at the end of its period." }),
  resume: z.boolean().meta({ description: "A cancelled self-service subscription can be resumed." }),
  manual: z.boolean().meta({ description: "A grant made by hand, which no self-service action may change." }),
});

export const BillingStatusResponseSchema = z.object({
  access: GatewayBillingAccessSchema,
  limits: PlanLimitsSchema,
  features: PlanFeatureAccessSchema,
  allowance: PlanAllowanceSchema.nullable().meta({
    description: "Null when billing cannot be read, no plan resolves, or the plan sets no monthly request limit, which counts nothing.",
  }),
  actions: SubscriptionActionsSchema,
}).meta({ id: "BillingStatusResponse" });

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
});

export const BillingPlansResponseSchema = z.object({ plans: z.array(BillingPlanOfferSchema) }).meta({ id: "BillingPlansResponse" });

/** The plan and period a purchase, change or resume names. */
export const BillingPlanSelectionSchema = z.object({
  planKey: z.string().min(1).max(100),
  billingPeriod: BillingPeriodSchema,
}).meta({ id: "BillingPlanSelection" });

/**
 * The account the console showed when the person acted. A write whose account
 * is no longer the one selected (another tab switched it) is refused with
 * `account_changed` rather than applied to the other account.
 */
const ShownAccount = { accountId: z.string().min(1).max(200) };

/**
 * The subscription the console showed when the dialog opened: its id, status
 * and period, each `null` where it showed none, and when the billing service
 * last changed it. A write on a subscription replaced, or changed in any way
 * since (a move between plans keeps the id, status and period, but not
 * `updatedAt`), is refused (`subscription_changed`) rather than applied to
 * what the person never saw. `subscriptionUpdatedAt` is optional: a client
 * that sends none is checked on the other three alone.
 */
const ShownSubscription = {
  subscriptionId: z.string().min(1).max(200).nullable(),
  subscriptionStatus: BillingSubscriptionStatusSchema.nullable(),
  subscriptionPeriod: BillingPeriodSchema.nullable(),
  subscriptionUpdatedAt: z.string().min(1).max(100).nullable().optional(),
};

/**
 * The price the console showed for the plan and period asked for. A change
 * bills without another screen, so a price changed since is refused
 * (`price_changed`) rather than charged.
 */
export const ShownPriceSchema = z.object({
  priceAmountCents: z.number().int(),
  priceCurrency: z.string().min(1).max(10),
}).meta({ id: "BillingShownPrice" });

/**
 * A checkout. The gateway chooses where the provider sends the person back
 * (the console's own pages); there is nothing to choose here.
 */
/**
 * A status read may name the account it expects: the checkout return's
 * confirmation does, so a read answered for another account selected since is
 * refused (`account_changed`), never taken as this one's plan (Sol 7b-8).
 */
export const BillingStatusQuerySchema = z.object({ account: z.string().min(1).max(200).optional() }).meta({ id: "BillingStatusQuery" });

export const BillingCheckoutRequestSchema = BillingPlanSelectionSchema.extend(ShownAccount).meta({ id: "BillingCheckoutRequest" });

/** A change, on the account and subscription the console showed, at the price it showed. */
export const BillingChangeRequestSchema = BillingPlanSelectionSchema.extend({
  ...ShownAccount,
  ...ShownSubscription,
  price: ShownPriceSchema,
}).meta({ id: "BillingChangeRequest" });

/** A resume, on the account and subscription the console showed. */
export const BillingResumeRequestSchema = BillingPlanSelectionSchema.extend({ ...ShownAccount, ...ShownSubscription }).meta({
  id: "BillingResumeRequest",
});

/** A cancel, on the account and subscription the console showed. */
export const BillingCancelRequestSchema = z.object({ ...ShownAccount, ...ShownSubscription }).meta({ id: "BillingCancelRequest" });

export const BillingCheckoutResponseSchema = z.object({ url: z.string() }).meta({ id: "BillingCheckoutResponse" });

/** A change or a resume. `requiredActionUrl` is the provider page a payment method has to be confirmed on first. */
export const BillingChangeResponseSchema = z.object({
  ok: z.literal(true),
  requiredActionUrl: z.string().optional(),
}).meta({ id: "BillingChangeResponse" });

export const BillingCancelResponseSchema = z.object({ ok: z.literal(true) }).meta({ id: "BillingCancelResponse" });

export const BillingTrialRequestSchema = z.object({ planKey: z.string().min(1).max(100), ...ShownAccount }).meta({ id: "BillingTrialRequest" });

export const BillingTrialResponseSchema = BillingAccessSchema.meta({ id: "BillingTrialResponse" });

/**
 * The account's plan, as `account status` shows it beside who is calling.
 * Left out on a deployment without billing.
 */
export const SessionBillingSchema = z.object({
  state: z.enum(["billed", "unavailable"]),
  planName: z.string().nullable().meta({ description: "The plan's name; null when no plan resolves or billing cannot be read." }),
  allowance: PlanAllowanceSchema.pick({ used: true, limit: true, resetAt: true }).nullable().meta({
    description: "This period's requests against the plan's allowance; null when the plan sets no monthly limit or it cannot be read.",
  }),
});

export type BillingSubscriptionStatus = z.infer<typeof BillingSubscriptionStatusSchema>;
export type EntitledPlan = z.infer<typeof EntitledPlanSchema>;
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;
export type BillingAccess = z.infer<typeof BillingAccessSchema>;
export type GatewayBillingAccess = z.infer<typeof GatewayBillingAccessSchema>;
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
export type PlanFeatureAccess = z.infer<typeof PlanFeatureAccessSchema>;
export type PlanAllowance = z.infer<typeof PlanAllowanceSchema>;
export type SubscriptionActions = z.infer<typeof SubscriptionActionsSchema>;
export type BillingStatusResponse = z.infer<typeof BillingStatusResponseSchema>;
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;
export type BillingPlanOffer = z.infer<typeof BillingPlanOfferSchema>;
export type BillingCheckoutResponse = z.infer<typeof BillingCheckoutResponseSchema>;
export type BillingChangeResponse = z.infer<typeof BillingChangeResponseSchema>;
export type BillingCancelResponse = z.infer<typeof BillingCancelResponseSchema>;
export type SessionBilling = z.infer<typeof SessionBillingSchema>;
export type BillingChangeRequest = z.infer<typeof BillingChangeRequestSchema>;
