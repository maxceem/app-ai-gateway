# Cloud billing service binding

For the hosted deployment only. The open-source gateway has no `BILLING`
binding, marks access as self-hosted and never reads a plan.

This note covers what the code cannot state for itself: the contract with an
external billing service, and the policy behind the gateway's side of it.

## Adding the binding

Bind a billing Worker's entrypoint in the [deployment
profile](../../docs/content/docs/self-hosting/deploy-with-wrangler.mdx) of the
deployment that needs it. Any Worker satisfying `BillingRuntime` in
`contract.ts` will do:

```jsonc
{
  "services": [
    { "binding": "BILLING", "service": "YOUR-BILLING-WORKER", "entrypoint": "BillingWorker" }
  ]
}
```

Never add it to the tracked `wrangler.jsonc`, and never to a deployment without
a billing service behind it. The console discovers availability from
`GET /v1/console/capabilities`.

The gateway always calls with service ID `app-ai-gateway` and the account ID as
the tenant ID. Matching service and plan data must exist in the billing worker
before the binding is enabled.

## Plans and the default plan

A tenant's plan is the plan of its access-granting subscription; without one it
is the billing service's configured **default plan**. There are no exceptions —
never subscribed, expired, and unpaid all land on the default plan and keep
serving traffic against its allowance. A `plan` of `null` means nothing
resolved at all: no default plan is configured, or the service is deactivated.

Status reports the resolved plan and the raw subscription separately because
they answer different questions: the plan is what the tenant may do, the
subscription is what it is paying for, reported verbatim even when it entitles
nothing. That separation is what lets the console say "your subscription has
ended" rather than only "you are on Free".

A link into the console may carry `?plan=<planKey>` on `/signup` or `/login`, as
the hosted pricing page's buttons do, and the visitor continues to checkout for
that plan after authenticating. It is a preference and never an entitlement:
an unknown key, the default plan, a plan already held, or a member without
permission to buy all fall back to the ordinary landing page.

## Plan limits

`limits` is opaque to the billing service and interpreted only by the gateway,
which reads the keys defined by `PlanLimits` in `contract.ts`. Every key is
optional: an omitted key means that resource is unlimited, and a plan with no
`limits` at all is unlimited in every respect. A value may be a number or a
numeric string; anything else — a fraction, a negative, `null` — is a plan
misconfiguration, and the gateway answers `502` rather than guess a ceiling.

No plan is named anywhere in gateway code. Putting a ceiling on a tier is plan
data alone; adding a *new kind* of ceiling is one key plus one enforcement
point.

### The request allowance

`maxRequestsPerMonth` counts requests dispatched during the current allowance
period, shared by every application, credential and end user the account owns,
and spent on the data plane only. The period follows the tenant, not the
calendar:

- The default Free plan anchors on the exact UTC instant the account was
  created and repeats monthly from that anniversary.
- A subscription uses its normalized billing schedule. Annual subscriptions
  still receive a fresh monthly allowance.
- An anniversary on day 29, 30 or 31 clamps to the last day of a shorter month
  and returns to the original day when a later month has it. The time of day is
  preserved.

Changing plans within the same schedule retains the current period's count, and
so does cancelling and resuming. A new paid subscription, or a
provider-confirmed change of cadence or anchor, starts a new schedule. Returning
to Free resumes the original account-anniversary schedule and the count already
recorded in that Free period — claim time, plan changes and cancellations never
become anchors.

### Unclaimed accounts

An unclaimed cloud account draws the ordinary Free default plan, not a trial or
onboarding plan of its own. This is the reason the gateway needs no trial plan,
subscription row, claim RPC or account-lifecycle policy in the billing service:
entitlement stays entirely on the billing side, and ownership and the free-access
clock stay entirely in gateway D1.

Nothing records the free window. The account's `created_at` dates it, and
`mgmt_organization.expires_at` — written only by a cloud bootstrap, cleared only
by a claim — is the whole test for "never had a human owner". While unclaimed
the account holds exactly one period that never renews, so nobody can draw a
second allowance without attaching a human identity; past its end the period
stays readable but admits nothing. That window is the free schedule's own first
period cut short, not a schedule of its own, so claiming only lifts the early
end: the schedule identity and revision are unchanged, the count already
recorded carries over, and the ordinary anniversary renewals resume without
inventing a subscription.

Ownership changes must invalidate both the request-scoped and the last-known
billing caches. The console reads the free window from the account summary it
already holds — `createdAt` plus a non-null `expiresAt` — rather than from
billing data.

## Failure and enforcement policy

Both failure modes fail closed, under codes that mean different things to a
client. No resolved plan answers `402 billing_payment_required`, which the
customer has to act on; with a default plan configured this is rare, since a
lapsed subscription drops to the free tier rather than to a paywall. An
unreachable billing service says nothing about the subscription, so it answers
`503 billing_unavailable` with a short `Retry-After` and is worth retrying.
Neither deletes or disables application records, so access resumes when billing
becomes readable again.

Configuration ceilings count stored rows rather than traffic, so nothing resets
them on a schedule. Each is enforced inside the statement that inserts the row,
as an extra condition on its `WHERE`, alongside whatever receipt or handoff
already guards that write — count and write are one statement, so two concurrent
creates cannot both read a count below the ceiling and then both succeed. A
refused write answers `409 billing_plan_limit_reached` and never succeeds on
retry. No ceiling ever removes or disables an existing row: an account that
drops to a lower plan keeps what it has and simply cannot add more.

The allowance is not a per-user limit and never caps what an account grants its
own users. Those are set per app and checked first.
