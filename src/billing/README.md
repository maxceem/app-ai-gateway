# Cloud billing service binding

This note is for the hosted deployment only. The open-source gateway has no `BILLING` binding and never reads a plan.


The open-source default has no `BILLING` binding. In that mode the gateway marks
access as self-hosted and does not impose subscription entitlements.

## Add the service binding

Hosted operators can bind a billing Worker's entrypoint in the
[deployment profile](../../docs/content/docs/self-hosting/deploy-with-wrangler.mdx) of the deployment that
needs billing. Any Worker satisfying `BillingRuntime` in
`src/billing/contract.ts` will do:

```jsonc
{
  "services": [
    {
      "binding": "BILLING",
      "service": "YOUR-BILLING-WORKER",
      "entrypoint": "BillingWorker"
    }
  ]
}
```

Do not add this binding to `wrangler.jsonc` or to a self-hosted deployment
unless it has a corresponding billing service. The console discovers availability from
`GET /v1/console/capabilities`.

The gateway always calls billing with service ID `app-ai-gateway` and the current
operator organization ID as the tenant ID. Create matching service and plan data
in the billing worker before enabling the binding.

## Plans, subscriptions and the default plan

A tenant's plan is the plan of its access-granting subscription. Without
one, it is the billing service's **default plan** — the free tier configured as
the billing service's default plan. There are no exceptions: a
tenant that never subscribed, whose subscription expired, or whose payment
went unpaid, all land on the same default plan and keep serving traffic against
its allowance.

`GET /v1/admin/billing/status` reports both halves separately, because they
answer different questions:

```json
{
  "access": {
    "state": "billed",
    "plan": { "planKey": "free", "planName": "Free", "limits": { "maxRequestsPerMonth": 1000 }, "isDefault": true },
    "subscription": {
      "subscriptionId": "123456",
      "status": "expired",
      "planKey": "growth",
      "planName": "Growth",
      "billingPeriod": "month",
      "renewsAt": null,
      "endsAt": "2026-09-01T00:00:00.000Z",
      "trialEndsAt": null,
      "source": "lemon_squeezy",
      "createdAt": "2026-05-18T09:30:00.000Z",
      "updatedAt": "2026-09-01T00:00:00.000Z",
      "billingAnchorDay": 18,
      "billingAnchorAt": "2026-05-18T09:30:00.000Z",
      "billingScheduleUpdatedAt": "2026-05-18T09:30:00.000Z"
    }
  }
}
```

`plan` is what the tenant may do — `isDefault` says whether it came from
the default plan rather than from a subscription. `subscription` is what it is
paying for, reported verbatim whether or not it still entitles anything, which is
what lets the console say "your subscription has ended" rather than only "you are
on Free". `state` is the gateway's own wrapper: `self_hosted` for a deployment
with no `BILLING` binding, `unavailable` when the billing service could not be
reached, and `billed` for the billing service's answer.

A `plan` of `null` means nothing resolved: the billing service has no default
plan configured, or the service has been deactivated.

### Preselecting a plan from outside the console

A link into the console may name the plan the visitor already chose, as
`?plan=<planKey>` on `/signup` or `/login` — this is what the hosted pricing
page's buttons do. The key is the billing catalog's own `planKey`. Once
authenticated, the operator is sent to `/checkout?plan=<planKey>`, which starts
the checkout for that plan instead of landing them on the apps page.

The parameter is a preference, never an entitlement: an unknown key, the
default free plan, a plan the organization already holds, or a member without
permission to buy all fall back to the billing page or the console landing page.
A deployment with no `BILLING` binding ignores it entirely.

## The plan's request allowance

A plan carries exactly one limit, and it is the gateway's only quota:

```json
{ "maxRequestsPerMonth": 100000 }
```

It is a whole, non-negative count of requests the tenant may dispatch
during its current monthly allowance period, shared by every application,
credential and end user it owns. A plan that omits the key leaves the
tenant unlimited. The value may be written as a number or as a JSON
string; anything else — a fraction, a negative, `null` — is a plan
misconfiguration, and the gateway answers `502 billing_unavailable` rather than
guess an allowance.

The period follows the tenant rather than the calendar:

- The default Free plan starts a period at the exact UTC date and time the
  tenant was created, then repeats monthly from that anniversary.
- A subscription uses its normalized billing schedule. Annual subscriptions
  still receive a new request allowance every month.
- An anniversary on day 29, 30, or 31 clamps to the last day of a shorter
  month, then returns to the original day when a later month has it. The UTC
  time of day stays the same.

Changing plans within the same subscription schedule retains the current
period's usage. Canceling and resuming also retain it. A new paid subscription
or a provider-confirmed change to the billing cadence or anchor starts a new
schedule. When a tenant returns to Free, it returns to the original
tenant-anniversary schedule and to the count already recorded in that
Free period.

Nothing about a stored application configuration is capped by a plan. Creating,
validating, and updating apps are entitlement checks only.

See the self-hosting operations guide for what a client sees when the allowance runs
out.

The allowance is not a per-user limit and does not cap what a tenant may
grant its own users. Those are set separately, per app, and they
are checked before the allowance; see
the application limits guide.

A tenant with no plan at all — `access.plan` is `null` — receives
`402 billing_payment_required` on its apps' data-plane routes. With a default plan
configured that is rare: a lapsed subscription drops to the free tier rather than
to a paywall, so `402` is left for the two cases where nothing resolves, namely a
billing service with no default plan and a deactivated service. Billing RPC
failures also fail closed, but under a different code: an unreachable billing
service says nothing about the subscription, so the gateway answers
`503 billing_unavailable` with a short `Retry-After` instead. Clients should
treat the first as something the customer has to act on and the second as worth
retrying. Neither condition deletes or disables application records, so access
resumes when billing becomes readable again.

`GET /v1/admin/billing/status` also reports the current allowance period beside
the access state, as `quota`:

```json
{
  "periodId": "paid:2026-05-18T09:30:00.000Z:2026-09-18T09:30:00.000Z",
  "periodStart": "2026-09-18T09:30:00.000Z",
  "periodEnd": "2026-10-18T09:30:00.000Z",
  "used": 41288,
  "limit": 100000,
  "resetAt": "2026-10-18T09:30:00.000Z"
}
```

`periodId` is opaque; use it for correlation rather than deriving dates from
it. `resetAt` is the same instant as `periodEnd`. `limit` is absent on a
plan that sets no ceiling. `quota` is `null` when no plan resolves or billing
is temporarily unavailable; self-hosted consoles do not fetch billing status.
The console renders the exact period and reset time in the viewer's time zone
and warns above every page once four fifths of the allowance is spent.

Owners and admins use `/v1/admin/billing/*` for plan listing, checkout, plan
changes, cancellation, resume, trials, and status. Members retain read-only
access to status and plan information.
