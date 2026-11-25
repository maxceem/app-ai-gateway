# Architecture rules

These rules matter only for rarer changes: a new table, Durable Object,
Worker or binding, a new place to keep data, or a change to how the docs
deploy. Everyday rules live in `AGENTS.md`.

Paths are for v2 (`v2/`). While v1 still lives at the root of this branch, its
matching files are named in brackets.

## Where data lives

Each kind of data has one home. Pick it with these five rules:

1. **Looked up or kept unique across all accounts** (login tokens, key
   hashes, emails, app ids): D1.
2. **Settings someone created or edits** (accounts, members, apps, provider
   connections, app users): D1.
3. **Records of what happened in one account** (charges, totals, sessions,
   events, and the pending work about them): one ledger object per account.
4. **A decision made during a request, with one writer** (limits, the plan
   allowance, the flood guard, the App Attest replay counter): a small object
   per thing counted.
5. **Temporary holding before data goes elsewhere:** a holding object per
   app.

Large content goes to R2.

When a case fits more than one rule:

- Needed exactly, right now, during a request: rule 4.
- Set by a person: D1. Something that happened: the ledger object.
- Found before the account is known: D1.

Why: D1 is one database with one writer and at most 10 GB, shared by every
account, while the ledger grows with every request. Nothing needs a report
across all accounts.

Step 8f moves the history tables out of D1 into the per-account ledger
object: `charge`, `usage_day`, `usage_month`, `budget_day`, `session`,
`open_work`, `app_auth_event` and `app_rejection_event`. Until then they are
still in D1.

## The two kinds of limits

Don't confuse the two kinds of limits. They never read each other.

- **The plan allowance** (`billing_*`, `v2/src/do/AccountLimiter.ts` and
  `v2/src/billing/allowance.ts`) is what the hosted gateway lets each
  customer use. It exists only on hosted deployments.
  [v1: `src/do/OrgQuota.ts`]
- **App limits** (`app_*`, `v2/src/do/AppLimiter.ts`,
  `v2/src/do/EndUserLimiter.ts` and `v2/src/do/request-limits.ts`) are what a
  customer lets each user of their app do.
  [v1: `src/do/UserLimiter.ts`]

## Sign-in library

Reach `@maxceem/cf-auth` only through `cfAuth()` in `v2/src/auth/identity.ts`
[v1: `src/auth/identity.ts`], and never import `better-auth` directly. A
static import puts them on every proxied request's cold start. Type-only
imports are fine.

## One compatibility date

Keep one Workers `compatibility_date` for every deployment: self-hosted,
hosted and tests alike. Every Worker's wrangler config in this branch
(`v2/wrangler.jsonc` [v1: `wrangler.jsonc`]) carries that same date, and they
change together. Don't set another in a deployment profile overlay unless it
is absolutely necessary and the owner has confirmed it. The release's
prebuilt deploy refuses one anyway.

## Docs deployment

- Keep docs out of the gateway Worker, and keep their deployment
  static-only: no route handlers, SSR, OpenNext, `run_worker_first` or Worker
  `main` entry without explicit approval.
- A custom docs domain belongs in a gitignored
  `docs/wrangler.<profile>.overlay.jsonc`, never in the tracked config.
