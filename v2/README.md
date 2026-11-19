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
| `src/index.ts` | The Worker. Only the health check so far. Everything else is a JSON 404. |
| `src/contracts/` | Every API operation, declared once. The OpenAPI document is generated from it. |
| `src/db/schema.ts` | The D1 schema. `migrations/` is generated from it. |
| `src/ledger/labels.ts` | The ledger's fixed value lists, shared by the schema and the code. |
| `src/providers/` | The provider description format, path handling and the matcher, plus the first provider descriptions. |
| `test/` | Tests that run in the Workers runtime, and compile-time checks (`operation-types.ts`). |
| `smoke/` | Checks against a live deployment. |

## Commands

Run from the repository root:

- `pnpm run v2:check`: types, generated Worker types and the generated OpenAPI document.
- `pnpm run v2:test`: the tests.

Inside `v2/`:

- `pnpm run db:generate`: write a migration after changing `src/db/schema.ts`.
- `pnpm run openapi:generate`: rewrite `openapi/openapi.json` after changing the catalog. Never edit it by hand.
- `pnpm run types`: rewrite `worker-configuration.d.ts` after changing `wrangler.jsonc`.
- `V2_BASE_URL=<origin> pnpm run smoke`: the smoke checks.

## Deploying

`wrangler.jsonc` holds what every deployment shares. A deployment's own Worker
name, database id, domains and placement go in a gitignored
`wrangler.<profile>.jsonc` next to it, used with `wrangler -c`. Migrations are
applied with `wrangler d1 migrations apply DB --remote -c wrangler.<profile>.jsonc`
before the Worker is deployed.
