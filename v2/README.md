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
| `src/index.ts` | The Worker: the health check, app sign-in and `/me`, and provider requests (`/v2/apps/{app}/proxy/{provider}/...`). Everything else is a JSON 404. The management code is loaded on first use (`src/management/`). An hourly cron settles expired App Attest challenges and cleans up sign-in approvals. Every refusal is logged once as `gateway_error`. |
| `src/management/` | Loaded on first use, so it is never on a provider request's cold start: the management API, people's sign-in (`/v2/auth/*`), the OAuth server for the CLI and MCP clients (`/v2/oauth/*` and `/.well-known/oauth-authorization-server/v2`), and the console's pages (`/v2/console/*`). |
| `src/auth/` | Sign-in settings from the environment (`settings.ts`), and the one place the sign-in library (`@maxceem/cf-auth`) is loaded (`identity.ts`). |
| `src/contracts/` | Every API operation, declared once (`catalog.ts`, which joins the app's own operations in `client-catalog.ts` and the management ones); the shapes of sign-in and access (`access.ts`); the app sign-in bodies (`auth.ts`), the management API's shapes (`admin.ts`) and the app settings, `authentication`, `routing` and `limits` (`app-config.ts`); and the billing service's shapes and plan limits (`billing.ts`). The OpenAPI document is generated from them. Provider requests are not in the catalog: they follow the provider descriptions. |
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
| `src/http/` | Reading request bodies with the 20 MiB limit, and the 10-second deadline on sign-in calls. |
| `src/core/`, `src/apps/` | Errors, logs, isolate caches with stale fallback, the origin guard, and loading an app. |
| `test/` | Tests that run in the Workers runtime, and compile-time checks (`operation-types.ts`). |
| `smoke/` | Checks against a live deployment; `smoke/mock/`, a mock OpenAI-compatible provider to call them against; and `smoke/billing-mock/`, a mock of the hosted billing service for the test deployment. |

## Commands

Run from the repository root:

- `pnpm run v2:check`: types, generated Worker types and the generated OpenAPI document.
- `pnpm run v2:test`: the tests.

Inside `v2/`:

- `pnpm run db:generate`: write a migration after changing `src/db/schema.ts`.
- `pnpm run openapi:generate`: rewrite `openapi/openapi.json` after changing the catalog. Never edit it by hand.
- `pnpm run types`: rewrite `worker-configuration.d.ts` after changing `wrangler.jsonc`.
- `V2_BASE_URL=<origin> pnpm run smoke`: the smoke checks. The first-call checks also need
  `V2_MANAGEMENT_KEY` and `V2_MOCK_URL` (the deployed mock), and the sign-in and MCP checks
  `V2_CONSOLE_URL` (the deployment's `CONSOLE_ORIGIN`), from the environment only.
- `node --experimental-strip-types scripts/management-key.ts --account <id> [--create-account <name>] [--remote -c wrangler.<profile>.jsonc]`:
  create a management key. It is printed once; store it, never commit it.

## Secrets

- `JWT_SECRET` signs gateway tokens: at least 32 bytes.
- `SECRET_VAULT_LOCAL_KEK_V1` seals provider keys in `local` vault mode: 32 bytes, base64. Back it up:
  without it, stored provider keys cannot be opened.
- `BETTER_AUTH_SECRET` signs console sessions and seals OAuth codes: at least 32 bytes. Every
  deployment needs it: without it, the whole management API answers 503, management keys included.
  Changing it signs everyone out.

## Sign-in settings

All optional, as Worker variables (see `src/auth/settings.ts`):

- `CONSOLE_ORIGIN`: where the console is served. The OAuth issuer is this origin plus `/v2`. Without
  it, the CLI and MCP clients cannot sign in.
- `ALLOWED_REGISTRATION_EMAILS`: on a self-hosted deployment, who may sign up (`*` for anyone).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OAUTH_RELAY_URL`: Google sign-in.
- `OAUTH_CLIENTS`, `OAUTH_CIMD`, `MCP_ALLOWED_ORIGINS`, `DEPLOYMENT_ID`, `TERMS_OF_SERVICE_URL`,
  `PRIVACY_POLICY_URL`.
- Set secrets with `wrangler secret put <NAME>`, never in a file that is committed. `.dev.vars.example`
  lists every secret.

## Deploying

`wrangler.jsonc` holds what every deployment shares. A deployment's own Worker
name, database id, domains and placement go in a gitignored
`wrangler.<profile>.jsonc` next to it, used with `wrangler -c`. Migrations are
applied with `wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc`
before the Worker is deployed.

One exception: migration `0005_cf_auth_1_0.sql` drops `mgmt_organization.expires_at`, which
Workers built before it still read on every management-key request. Deploy the new Worker first,
then apply `0005`. The new Worker works with the column still there.

On a host shared with v1, the v2 Worker needs these routes, while v1 keeps its own paths
(`/.well-known/oauth-*` without `/v2` included):

- `/v2` and `/v2/*`;
- `/.well-known/oauth-authorization-server/v2`;
- `/.well-known/oauth-protected-resource/v2` and `/.well-known/oauth-protected-resource/v2/*`.

Without the last two, the CLI and MCP clients cannot find the sign-in server.
