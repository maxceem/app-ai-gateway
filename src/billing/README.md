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
and spent on the data plane only. The period is a month measured from the
plan's own anchor, so an account's allowance resets on the date its plan does:

- A paid plan renews on its subscription's billing anchor, as the billing
  service reports it (`billingAnchorAt`, and `billingAnchorDay` where a short
  month clamps it). Annual subscriptions still receive a fresh allowance each
  month, on that day.
- The default free plan renews on the day the account was created.

A schedule that starts on the 31st renews on the last day of shorter months and
returns to the 31st, counted from the original anchor each time rather than
from the previous renewal.

The counter is keyed by `periodId`: the schedule (`free:` and the account's
creation instant, or `paid:` and the subscription generation's) and the
period's start. A change of limit within the same schedule is a new limit over
the same counter, so a downgrade below what the period has spent refuses
further requests until it renews. A change of schedule is a new counter:
subscribing starts the subscription's own period from zero, and returning to
the free plan resumes the free period the account was in, with what it had
already spent, so cancelling never hands out a second free allowance.

No schedule revision or superseded marker reconciles a stale cached plan with
a new one. What a stale cache can do instead is count against the previous
schedule, or apply the previous plan's limit, for as long as it lives: up to 30
seconds normally, and up to an hour while the billing service is unreachable
and the last known answer is served instead. That includes a stale unlimited
plan, which counts nothing while it is served. It is an availability trade
taken on purpose — the alternative is refusing every request during a billing
outage — and a change is enforced everywhere once each isolate's cache has
turned over.

A plan with no monthly limit counts nothing and touches no quota object, so
the billing status and the CLI report no usage figure for it rather than a
zero nobody measured.

A request is counted toward the period it was admitted in, even if it crosses
the renewal instant on its way through the gate. An anchor slightly in the
future is clock skew between this Worker and billing and is answered with a
retry; one further off is refused as invalid billing data.

### Unclaimed accounts

An unclaimed cloud account draws the ordinary Free default plan, not a trial or
onboarding plan of its own. This is the reason the gateway needs no trial plan,
subscription row, claim RPC or account-lifecycle policy in the billing service:
entitlement stays entirely on the billing side, and ownership and the free-access
clock stay entirely in gateway D1.

Nothing records the free window. The account's `created_at` dates it, and
`mgmt_organization.expires_at` — written only by a cloud bootstrap, cleared only
by a claim — is the whole test for "never had a human owner". While unclaimed
the account holds its first period until its free window closes, however far
past the first renewal that runs, so nobody can draw a second allowance without
attaching a human identity; past its end the period stays readable but admits
nothing. Claiming before the first renewal keeps the same key and so the same
count; claiming after it, while the free window is still open, moves the
account onto the renewed period. From then on it renews on the day it was
created.

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
as an extra condition on its `WHERE`, alongside whatever CLI operation
already guards that write — count and write are one statement, so two concurrent
creates cannot both read a count below the ceiling and then both succeed. A
refused write answers `409 billing_plan_limit_reached` and never succeeds on
retry. No ceiling ever removes or disables an existing row: an account that
drops to a lower plan keeps what it has and simply cannot add more.

The allowance is not a per-user limit and never caps what an account grants its
own users. Those are set per app and checked first.
