# Architecture rules

These rules matter only for rarer changes. Everyday rules live in
`AGENTS.md`. Read this file before you:

- add a table, Durable Object, Worker or binding, or change where data is
  kept;
- change sign-in code, or what imports the sign-in library;
- change request limits or the plan allowance;
- change a compatibility date;
- change how the docs deploy.

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

The history tables live in the ledger object (`v2/src/do/AccountLedger.ts`,
schema in `v2/src/ledger/schema.ts`): `charge`, `usage_day`, `usage_month`,
`budget_day`, `session`, `open_work`, `app_auth_event` and
`app_rejection_event`. Code reaches an account's ledger with
`ledgerDb(env, accountId)` (`v2/src/ledger/database.ts`), which has D1's
shape. A batch there is one transaction in the object. A statement can
never join a ledger table with a D1 table: read the settings from D1 first,
then write to the ledger.

A change to a ledger table is a new version at the end of `LEDGER_SCHEMA`,
never an edit of a merged one. Each object applies it when it next wakes.

v2 has no way to delete an account yet. Whatever adds one must also clear
that account's ledger object. Inside the object: `ctx.storage.deleteAlarm()`,
then `ctx.storage.deleteAll()`, then run the schema setup again
(`migrateLedger`) so the live instance has empty tables, and return normally.
The caller then gets a plain success or a real error. Rows may come back
from a late failed-write retry, or from alarm work that was already running;
their detail ages out, and a monthly total may stay. That is accepted.

## The two kinds of limits

Don't confuse the two kinds of limits. They never read each other.

- **The plan allowance** (`billing_*`, `v2/src/do/AccountLimiter.ts` and
  `v2/src/billing/allowance.ts`) is what the hosted gateway lets each
  customer use. It exists only on hosted deployments.
  [v1: `src/do/OrgQuota.ts`]
- **App limits** (`app_*`, `v2/src/do/AppLimiter.ts`,
  `v2/src/do/EndUserLimiter.ts` and `v2/src/do/request-limits.ts`) are what a
  customer lets their app do: each user of the app (`EndUserLimiter`), and the
  app as a whole, with its request limits and monthly spending cap
  (`AppLimiter`).
  [v1: `src/do/UserLimiter.ts`]

## Sign-in library

Reach `@maxceem/cf-auth` only through `cfAuth()` in `v2/src/auth/identity.ts`
[v1: `src/auth/identity.ts`], and never import `better-auth` directly. A
static import puts them on every proxied request's cold start. Type-only
imports are fine.

## One compatibility date

Keep one Workers `compatibility_date` for every deployment: self-hosted,
hosted and tests alike. Every gateway Worker's wrangler config in this branch
carries that same date, and they change together: `v2/wrangler.jsonc`, the
vault Worker's `v2/vault/wrangler.jsonc`, the smoke Workers under `v2/smoke/`
[v1: `wrangler.jsonc`]. Don't set another in
a deployment profile overlay unless it is absolutely necessary and the user
has confirmed it; the release's prebuilt deploy refuses one anyway. The
static docs deployment (`docs/wrangler.jsonc`) is separate and keeps its own
date.

## The vault Worker

`v2/vault/` is the only Worker that opens provider keys outside a live
session. It seals a key as soon as the gateway receives it, and sends every
call that carries one, only to the address the key is sealed for. Keep it
plain JavaScript with no npm packages, type-checked through JSDoc and
uploaded as it is. The gateway reaches it only through
`v2/src/vault/client.ts`. A new built-in provider host must be added to
`v2/vault/src/hosts.js` too; a test fails until it is.

## Docs deployment

- Keep docs out of the gateway Worker, and keep their deployment
  static-only: no route handlers, SSR, OpenNext, `run_worker_first` or Worker
  `main` entry without explicit approval.
- A custom docs domain belongs in a gitignored
  `docs/wrangler.<profile>.overlay.jsonc`, never in the tracked config.
