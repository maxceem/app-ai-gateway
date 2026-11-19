/**
 * The hosted billing service's wire shapes, and the plan limits this gateway
 * reads out of a plan.
 *
 * Ported from v1's `src/contracts/billing.ts`, keeping only what the request
 * path reads. The billing service is an optional service binding (`BILLING`):
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
 * request path, per plan period. The ceilings on stored settings (v1's
 * `maxApps`, `maxProviders`, `maxActiveKeysPerApp`, …) are read and enforced
 * with the rest of the management API in step 1d.
 *
 * This is the plan allowance an account pays for. It never caps, and is never
 * read by, the limits an app sets on its own end users (`app_*`).
 */
export const PlanLimitsSchema = z.object({
  maxRequestsPerMonth: z.number().int().optional()
    .meta({ description: "Requests the account may send to providers per plan period." }),
  maxSessionMinutesPerMonth: z.number().int().optional()
    .meta({ description: "Live session minutes the account may use per plan period. Enforced once live sessions exist." }),
});

/**
 * One plan limit as plan data may carry it. JSON has no integer type, so
 * `10000`, `10000.0` and `"10000"` mean the same; a fraction, a negative, a
 * boolean, `null`, an object or an empty string is not a count.
 */
const PlanLimitInputSchema = z.union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().int().nonnegative())
  .optional();

/** Plan limits as plan data carries them. Keys this gateway does not read are ignored. */
export const PlanLimitsInputSchema = z.object({
  maxRequestsPerMonth: PlanLimitInputSchema,
  maxSessionMinutesPerMonth: PlanLimitInputSchema,
});

export type BillingSubscriptionStatus = z.infer<typeof BillingSubscriptionStatusSchema>;
export type EntitledPlan = z.infer<typeof EntitledPlanSchema>;
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;
export type BillingAccess = z.infer<typeof BillingAccessSchema>;
export type GatewayBillingAccess = z.infer<typeof GatewayBillingAccessSchema>;
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
