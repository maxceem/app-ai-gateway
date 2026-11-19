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
| `src/index.ts` | The Worker: the health check, app sign-in and `/me`, the management API, and provider requests (`/v2/apps/{app}/proxy/{provider}/...`). Everything else is a JSON 404. An hourly cron settles expired App Attest challenges. Every refusal is logged once as `gateway_error`. |
| `src/contracts/` | Every API operation, declared once (`catalog.ts`); the sign-in bodies (`auth.ts`), the management API's shapes (`admin.ts`) and the app settings, `authentication` and `routing` (`app-config.ts`). The OpenAPI document is generated from them. Provider requests are not in the catalog: they follow the provider descriptions. |
| `src/db/schema.ts` | The D1 schema. `migrations/` is generated from it; `0002_ledger.sql` also holds the hand-written rollup trigger. |
| `src/money.ts` | Money as whole nano-dollars (D20): the branded type and its helpers. Rounding happens once, when a charge is priced. |
| `src/pricing/` | The price file (`models.json`, v1's, copied as it is), its integer rates, customer rates, and pricing token usage. |
| `src/ledger/` | The ledger's fixed value lists, and writing charges: one D1 batch, `ON CONFLICT(id) DO NOTHING`, then the app's failed-write store, then the logs. |
| `src/proxy/` | The call path: matching, the app's routing policy, the OpenAI chat request policy, sending upstream, watching the answer, reading usage and writing one charge per attempt. |
| `src/admin/` | The minimal management API: management keys, apps, app keys and provider connections. |
| `src/providers/` | The provider description format, path handling and the matcher, the first provider descriptions, and provider connections as the request path reads them. |
| `src/vault/` | Sealing provider keys, from v1: `local` or `kms` mode. |
| `src/client-auth/` | Who is calling: app keys, issuer tokens, gateway tokens, App Attest keys, assertions and per-request proofs, AppTransaction, the replay check, blocked users and auth events. `authenticateRequest` is the request path's entry point. |
| `src/diagnostics/` | Rejection events: sampled records of provider requests refused before the provider. |
| `src/routes/` | The sign-in routes (`/v2/apps/{app}/auth/*`) and `/v2/apps/{app}/me`. |
| `src/do/` | Durable Objects: the end user's limiter (the App Attest replay counter for now), the sign-in flood limiter, and the per-app store for ledger writes that failed. |
| `src/http/` | Reading request bodies with the 20 MiB limit, and the 10-second deadline on sign-in calls. |
| `src/core/`, `src/apps/` | Errors, logs, isolate caches with stale fallback, the origin guard, and loading an app. |
| `test/` | Tests that run in the Workers runtime, and compile-time checks (`operation-types.ts`). |
| `smoke/` | Checks against a live deployment, and `smoke/mock/`, a mock OpenAI-compatible provider to call them against. |

## Commands

Run from the repository root:

- `pnpm run v2:check`: types, generated Worker types and the generated OpenAPI document.
- `pnpm run v2:test`: the tests.

Inside `v2/`:

- `pnpm run db:generate`: write a migration after changing `src/db/schema.ts`.
- `pnpm run openapi:generate`: rewrite `openapi/openapi.json` after changing the catalog. Never edit it by hand.
- `pnpm run types`: rewrite `worker-configuration.d.ts` after changing `wrangler.jsonc`.
- `V2_BASE_URL=<origin> pnpm run smoke`: the smoke checks. The first-call checks also need
  `V2_MANAGEMENT_KEY` and `V2_MOCK_URL` (the deployed mock), from the environment only.
- `node --experimental-strip-types scripts/management-key.ts --account <id> [--create-account <name>] [--remote -c wrangler.<profile>.jsonc]`:
  create a management key. It is printed once; store it, never commit it.

## Secrets

- `JWT_SECRET` signs gateway tokens: at least 32 bytes.
- `SECRET_VAULT_LOCAL_KEK_V1` seals provider keys in `local` vault mode: 32 bytes, base64. Back it up:
  without it, stored provider keys cannot be opened.
- Set secrets with `wrangler secret put <NAME>`, never in a file that is committed. `.dev.vars.example`
  lists every secret.

## Deploying

`wrangler.jsonc` holds what every deployment shares. A deployment's own Worker
name, database id, domains and placement go in a gitignored
`wrangler.<profile>.jsonc` next to it, used with `wrangler -c`. Migrations are
applied with `wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc`
before the Worker is deployed.
