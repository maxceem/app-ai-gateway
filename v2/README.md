# App AI Gateway v2

The v2 gateway Worker, built step by step on the `v2` branch. It runs beside v1
until v1 shuts down, under `/v2/*`. At release it moves to the repository root
and replaces v1's gateway code.

The plan, the order of work and every decision behind this code are outside the
repository, in the maintainer's v2 architecture plan. This folder holds only
what is built so far.

## What is here

| Path | What it is |
| --- | --- |
| `src/index.ts` | The Worker: the health check, app sign-in and `/me`, and provider requests (`/v2/apps/{app}/proxy/{provider}/...`). A browser loading a console page with no file of its own, such as `/v2/login`, gets the console's document. Everything else is a JSON 404. The management code is loaded on first use (`src/management/`). An hourly cron settles expired App Attest challenges and cleans up sign-in approvals. Every refusal is logged once as `gateway_error`. |
| `src/management/` | Loaded on first use, so it is never on a provider request's cold start: the management API, people's sign-in (`/v2/auth/*`), the OAuth server for the CLI and MCP clients (`/v2/oauth/*` and `/.well-known/oauth-authorization-server/v2`), and the console's pages (`/v2/console/*`). |
| `src/auth/` | Sign-in settings from the environment (`settings.ts`), and the one place the sign-in library (`@maxceem/cf-auth`) is loaded (`identity.ts`). |
| `src/contracts/` | Every API operation, declared once (`catalog.ts`, which joins the app's own operations in `client-catalog.ts` and the management ones); the shapes of sign-in and access (`access.ts`); the app sign-in bodies (`auth.ts`), the management API's shapes (`admin.ts`) and the app settings, `authentication`, `routing` and `limits` (`app-config.ts`); and the billing service's shapes and plan limits (`billing.ts`). The OpenAPI document is generated from them. Provider requests are not in the catalog: they follow the provider descriptions. |
| `console/` | The console, a React app ported from v1's (`console/` at the repository root). It is built into `console/dist/v2/` and served as this Worker's static files, under `/v2` (`/v2/login`, `/v2/access`, `/v2/oauth/consent`, `/v2/device`). |
| `src/db/schema.ts` | The D1 schema. `migrations/` is generated from it; `0002_ledger.sql` also holds the hand-written rollup trigger. |
| `src/money.ts` | Money as whole nano-dollars (D20): the branded type and its helpers. Rounding happens once, when a charge is priced. |
| `src/pricing/` | The price file (`models.json`, v1's, copied as it is), its integer rates, customer rates, and pricing token usage. |
| `src/ledger/` | The ledger's fixed value lists, and writing charges: one D1 batch, `ON CONFLICT(id) DO NOTHING`, then the app's failed-write store, then the logs. |
| `src/ledger/corrections.ts` | Settling a charge or a job from the provider's final figure (units at the stored rates, or dollars as reported), and pricing an `unresolved` charge. One correction per owner. |
| `src/ledger/sessions.ts` | The session row, checkpoints (one D1 batch that writes the slice and answers continue or stop), `close`, and settlement with its barrier. |
| `src/ledger/sweep.ts` | The minute sweep of open work: earliest due first, small batches, a time limit per item, retries, and giving up after a set number of tries. |
| `src/proxy/` | The call path: matching, the app's routing policy, the OpenAI chat request policy, sending upstream, watching the answer, reading usage and writing one charge per attempt. |
| `src/admin/` | The management API: who is calling (a management key, an OAuth token or a console session), access (accounts, management keys, CLI and MCP sign-ins), apps, app keys, end users and provider connections. |
| `src/mcp/` | The MCP endpoint (`/v2/mcp`, loaded on first use): the bearer gate, the tools (each runs one management API operation as the caller), the guide, and the tool list the CLI builds its commands from (`/v2/cli/tools`). No tool takes or returns a secret. |
| `src/providers/` | The provider description format, path handling and the matcher, the first provider descriptions, and provider connections as the request path reads them. |
| `src/vault/` | Sealing provider keys, from v1: `local` or `kms` mode. |
| `src/client-auth/` | Who is calling: app keys, issuer tokens, gateway tokens, App Attest keys, assertions and per-request proofs, AppTransaction, the replay check, blocked users and auth events. `authenticateRequest` is the request path's entry point. |
| `src/diagnostics/` | Rejection events: sampled records of provider requests refused before the provider. |
| `src/routes/` | The sign-in routes (`/v2/apps/{app}/auth/*`) and `/v2/apps/{app}/me`. |
| `src/do/` | Durable Objects: the three limiters (the end user's, with the App Attest replay counter and the user's limits; the app's; the account's plan allowance), the sign-in flood limiter, and the per-app store for ledger writes that failed. |
| `src/limits/` | Admission: the three limiters one after another, the replay check's own deadline and the one deadline the other checks share, and budget totals from the rollups. |
| `src/billing/` | The hosted billing service (the optional `BILLING` binding): reading an account's plan, plan periods from 00:00 UTC on the renewal day, and spending the plan allowance without ever failing a request. |
| `src/helpdesk/`, `src/admin/support.ts` | Human support: the help desk contract (the optional `HELPDESK` binding) and the support message. Offered only with billing, a help desk and `SUPPORT_EMAIL`, for a plan that includes `humanSupport`. |
| `src/analytics/` | The optional `ANALYTICS` sign-up hook (`hook.ts`) and `MANAGEMENT_ANALYTICS` dataset (`management.ts`). Each file declares everything sent to or written to its binding. Unbound, nothing is read or sent. Never used on an app's own requests. |
| `src/http/` | Reading request bodies with the 20 MiB limit, and the 10-second deadline on sign-in calls. |
| `src/core/`, `src/apps/` | Errors, logs, isolate caches with stale fallback, the origin guard, and loading an app. |
| `test/` | Tests that run in the Workers runtime, and compile-time checks (`operation-types.ts`). |
| `smoke/` | Checks against a live deployment; `smoke/mock/`, a mock OpenAI-compatible provider to call them against; `smoke/billing-mock/`, a mock of the hosted billing service for the test deployment; `smoke/mail-mock/`, which stands in for the email sender and sends nothing; and `smoke/helpdesk-mock/`, which stands in for the help desk and emails only through the mail mock. |

## Commands

Run from the repository root:

- `pnpm run v2:check`: types, generated Worker types and the generated OpenAPI document.
- `pnpm run v2:test`: the tests.
- `pnpm run v2:console:check`, `pnpm run v2:console:test`: the console's types and tests.
- `pnpm run v2:console:build`: build the console. Every deploy needs it first.

Inside `v2/`:

- `pnpm run db:generate`: write a migration after changing `src/db/schema.ts`.
- `pnpm run openapi:generate`: rewrite `openapi/openapi.json` after changing the catalog. Never edit it by hand.
- `pnpm run types`: rewrite `worker-configuration.d.ts` after changing `wrangler.jsonc`.
- `V2_BASE_URL=<origin> pnpm run smoke`: the smoke checks. The first-call checks also need
  `V2_MANAGEMENT_KEY` and `V2_MOCK_URL` (the deployed mock), and the sign-in and MCP checks
  `V2_CONSOLE_URL` (the deployment's `CONSOLE_ORIGIN`), from the environment only. The console
  checks need `V2_CONSOLE_URL` alone. The Cloudflare AI Gateway check also needs
  `V2_MOCK_CLOUDFLARE=1`, set only for a deployment built with the mock as Cloudflare's stand-in.
  The billing checks need `V2_BILLING_MOCK=1`, set only for a deployment bound to `smoke/billing-mock/`.
  Every request the checks send names itself with the `user-agent` `agw-smoke/<version>`
  (`smoke/user-agent.ts`, which `pnpm run smoke` loads first).
- `node --experimental-strip-types --import ./smoke/user-agent.ts --test smoke/email.smoke.ts`: the email check, run on its own. It
  needs `V2_BASE_URL`, `V2_CONSOLE_URL` and `V2_MAIL_URL` (the deployed `smoke/mail-mock/`). Its
  support check also needs `V2_HELPDESK_MOCK=1`, set only for a deployment whose `HELPDESK` binding
  is `smoke/helpdesk-mock/`, and runs only when the deployment's support inbox is an `example.test`
  address. Otherwise it skips and sends nothing to any help desk.
- `node --experimental-strip-types scripts/management-key.ts --account <id> [--create-account <name>] [--remote -c wrangler.<profile>.jsonc]`:
  create a management key. It is printed once; store it, never commit it.
- `pnpm run secrets:setup-local`: fill `.dev.vars` (ignored by git) with a fresh value for each
  secret `.dev.vars.example` lists that has none yet. Values already there are kept; only names are
  printed. Back up `SECRET_VAULT_LOCAL_KEK_V1`.
- `pnpm run secrets:upload -- -c <wrangler config>`: upload the values set in `.dev.vars` to the
  Worker that config names (`wrangler secret bulk`, values on stdin). Empty values are left out.
- `pnpm run recover-access -- --email <email> (--local | --remote -c <wrangler config>)
  [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]`: let a person back in
  with a new password, and make them an owner of an account they belong to. It reads the database
  first and shows what it will change; `--dry-run` stops there. It asks before changing anything
  (`--yes` answers for a run without a terminal). The password comes from a hidden prompt or a pipe,
  never an argument, and is never printed. A new password also signs the person out everywhere (v1 left
  their sessions); making someone an owner does not.

## Secrets

- `JWT_SECRET` signs gateway tokens: at least 32 bytes.
- `SECRET_VAULT_LOCAL_KEK_V1` seals provider keys in `local` vault mode: 32 bytes, base64. Back it up:
  without it, stored provider keys cannot be opened.
- `BETTER_AUTH_SECRET` signs console sessions and seals OAuth codes: at least 32 bytes. Every
  deployment needs it: without it, the whole management API answers 503, management keys included.
  Changing it signs everyone out.

## Test deployment settings

- `define: { "__TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__": "\"<mock URL>\"" }` in the test deployment's own
  Wrangler config: where connections set to go through Cloudflare AI Gateway send their requests,
  instead of `https://gateway.ai.cloudflare.com/`, so no request reaches Cloudflare. It is compiled
  in at build time; no Worker variable can set it. Never add it to any other config.

## Sign-in settings

All optional, as Worker variables (see `src/auth/settings.ts`):

- `CONSOLE_ORIGIN`: where the console is served. The OAuth issuer is this origin plus `/v2`. Without
  it, the CLI and MCP clients cannot sign in. A deployment that sends email needs it too: the
  verification links open there. Without it, health reports `email: "misconfigured"` and sign-up
  with a password answers `email_unavailable`.
- `ALLOWED_REGISTRATION_EMAILS`: on a self-hosted deployment, who may sign up (`*` for anyone).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OAUTH_RELAY_URL`: Google sign-in.
- `OAUTH_CLIENTS`, `OAUTH_CIMD`, `MCP_ALLOWED_ORIGINS`, `DEPLOYMENT_ID`, `TERMS_OF_SERVICE_URL`,
  `PRIVACY_POLICY_URL`.
- Set secrets with `wrangler secret put <NAME>`, never in a file that is committed. `.dev.vars.example`
  lists every secret.

## Hosted billing settings

Only a deployment that binds the billing service (`BILLING`) has billing; everywhere else the
billing operations answer 404 and nothing is counted against a plan.

- `BILLING_PAYMENT_HOSTS`: optional, a comma-separated list of hosts (each also covering its
  subdomains) where a checkout or payment page the billing service answers may be. The gateway
  passes such a page on only when it is HTTPS on one of these hosts, and answers
  `billing_unavailable` otherwise. Defaults to `lemonsqueezy.com`.
- Where a completed checkout sends the person back is always the console's own page, built from
  `CONSOLE_ORIGIN` (or the gateway's own origin without one). The billing provider has no page
  for an abandoned checkout; the billing service keeps the console's billing page with it.
  Store-domain checkout pages on a custom domain need that domain in `BILLING_PAYMENT_HOSTS`.

## Nightly maintenance

The hourly cron (`src/maintenance/nightly.ts`) also runs two daily jobs, each in its own hour:

- At 03:17 UTC it deletes stored conversations past each app's retention. It goes round every
  app once, with at most 500 R2 calls and the D1 queries `MAINTENANCE_QUERY_BUDGET` leaves after
  the hourly clean-up: 42 by default, one per page of conversations it deletes. That keeps up with
  about 40 apps that each have one page expire a night. Where it runs out before every
  app had its turn, it logs `conversation_retention_incomplete` as a warning and goes on the next night where it stopped.
- At 04:17 UTC it runs the nightly maintenance. This deletes auth and rejection events after 90
  days, and detailed usage after 90 days: charges, settled sessions and budget totals. A call's,
  job's or session's corrections are deleted before its other charges, so a user's usage never
  shows a correction without its charge. Day totals stay 400 days, then move into month totals.
  It also logs `ledger_sessions_stuck_open` when a session past 90 days is still open with nothing
  left to settle it: it is kept, with its charges, until someone looks.

The ledger takes no charge dated more than 30 days back, such as a job's settlement that arrives
after that, or an old charge replayed. That is 60 days before retention may delete anything, so a
late result can never be counted twice. The app is still served as usual. Nothing is booked, and
`ledger_booking_too_late` is logged as a warning. A session whose provider total comes too late
keeps its slices' estimate and is marked `estimate_kept`. The longest wait a booking has on purpose
is about 8 days, a job's saved result retried by the sweep, so in practice nothing is refused.

Each kind of old row is a pass, and the passes take turns: each round, every pass with rows left
deletes one chunk of at most 5,000 rows. So a large backlog of one kind never keeps the others
waiting. The run stops when every pass is done, or when one of two allowances runs out:

- **D1 statements:** at most 50, the Workers Free plan's limit per run.
- **Rows written:** at most 20,000. D1 counts each deleted row and each of its index entries. The
  Free plan allows 100,000 row writes a day for the whole account, and the apps need the rest.
  This allowance covers the retention passes only. The hourly clean-up of expired App Attest
  challenges is not counted in it: each hour it settles about one hour of challenges.

At the defaults, a night deletes about 2,000 charges when charges are the only backlog, because
each charge is counted as 10 row writes with its index entries. A deployment that serves more than about
2,000 requests a day falls behind and logs `maintenance_backlog_left` every night. It should raise
`MAINTENANCE_ROW_BUDGET`. On the Free plan, the apps' own writes leave little room to do that, so
past about 2,000 requests a day the Paid plan is the better fit.

A backlog left over is cleared over the next nights, and the run logs `maintenance_backlog_left` as
a warning. On the Workers Paid plan, two optional Worker variables clear it faster:

- `MAINTENANCE_QUERY_BUDGET` (for example `1000`). A value above 1,000, D1's limit on that plan, is
  lowered to 1,000. It also raises conversation retention's D1 queries.
- `MAINTENANCE_ROW_BUDGET` (for example `1000000`). A value above 5,000,000 is lowered to 5,000,000.

## Deploying

`wrangler.jsonc` holds what every deployment shares. A deployment's own Worker
name, database id, domains and placement go in a gitignored
`wrangler.<profile>.jsonc` next to it, used with `wrangler -c`. Migrations are
applied with `wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc`
before the Worker is deployed. Build the console (`pnpm run v2:console:build`) before every
deploy: the Worker uploads `console/dist/` as its static files.

One exception: migration `0005_cf_auth_1_0.sql` drops `mgmt_organization.expires_at`, which
Workers built before it still read on every management-key request. Deploy the new Worker first,
then apply `0005`. The new Worker works with the column still there.
Migration `0011_email_pending_verification.sql` follows the usual order: apply it, then deploy.
The old `account_activation` table stays for now: this Worker no longer writes it, while older
ones still do. A later release drops it, once every deployment runs a Worker that does not.

Email verification can be turned on at any time. Only an account a password sign-up makes while it
is on waits for its owner's address, and only until that address is verified: by the emailed link,
or by signing in with a Google account linked to the same address. Linking Google alone does not
verify it; the owner signs in with it once. Apps may then wait up to 10 seconds more on servers
that cached the refusal. Every account made before, or by `management-key.ts --create-account`,
keeps serving its apps.

On a host shared with v1, the v2 Worker needs these routes, while v1 keeps its own paths
(`/.well-known/oauth-*` without `/v2` included):

- `/v2` and `/v2/*`;
- `/.well-known/oauth-authorization-server/v2`;
- `/.well-known/oauth-protected-resource/v2` and `/.well-known/oauth-protected-resource/v2/*`.

Without the last two, the CLI and MCP clients cannot find the sign-in server.
