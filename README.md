# App AI Gateway

A multi-tenant LLM proxy for Cloudflare Workers. It keeps provider keys out of
client applications and supports OpenAI, Anthropic, xAI, Gemini, Perplexity,
DeepSeek, Groq, Mistral, Together AI, Fireworks AI, Cerebras, Moonshot AI,
Hugging Face, Baseten, ByteDance, and OpenRouter.

**[Documentation](https://docs.appaigateway.com/docs/)** ·
**[API reference](https://docs.appaigateway.com/docs/api/)**

## Deploy

Requirements: a Cloudflare account. Nothing else — no second service, and no
Cloudflare AI Gateway.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxceem/app-ai-gateway)

The deployment form provisions the Worker, D1 database, Durable Object, admin
console, and future deployments. It requires one value:

| Variable | How to obtain it |
| --- | --- |
| `SECRET_VAULT_LOCAL_KEK_V1` | Run `openssl rand -base64 32`. This key encrypts the provider credentials you add later in the console; back it up, because losing it makes them unreadable. |

`JWT_SECRET` and `BETTER_AUTH_SECRET` are generated automatically. After the
first deployment, create the initial operator account at `/v1/auth/sign-up/email`,
then set `ALLOW_PUBLIC_REGISTRATION=false` for a private deployment.

Model-provider credentials are added per organization under **Providers** in the
console. They are probed, encrypted, and never displayed again. An organization
can also route a provider through its own **Cloudflare AI Gateway** (account id,
gateway id, and token) or **Vercel AI Gateway** (an API key) by supplying the
connection once — an optional routing choice, not a deployment requirement.
Model IDs stay the provider's own on every route. Never put provider keys in this
repository or in Worker variables.

Hardened deployments can instead set `SECRET_VAULT_MODE=kms` with
`SECRET_VAULT_KMS_URL` and `SECRET_VAULT_KMS_TOKEN`, which keeps the root key in
a separate [cf-kms](https://github.com/maxceem/cf-kms) deployment in its own
Cloudflare account. `/v1/healthz` reports `"vault": "ok"` or `"misconfigured"`
either way.

For a manual deployment:

```sh
pnpm install
cp .dev.vars.example .dev.vars # generate SECRET_VAULT_LOCAL_KEK_V1
pnpm run secrets:upload
pnpm run deploy
```

## Run locally

Requirements: Node.js 22+, pnpm 11, and Wrangler 4.

```sh
pnpm install
cp .dev.vars.example .dev.vars
# Put `openssl rand -base64 32` into SECRET_VAULT_LOCAL_KEK_V1
pnpm run secrets:setup-local
pnpm run db:migrate:local
pnpm run dev
```

The Worker and admin console are available at `http://localhost:8787`; verify
the API with:

```sh
curl http://localhost:8787/v1/healthz
```

Sign up through `/v1/auth/sign-up/email`, then create the first organization-owned
application through the console or admin API. No personal tenant seed is included
in the public repository.

Run the full verification suite with `pnpm run check`. Configuration, client
integration, authentication, and API details are covered in the
[documentation](https://docs.appaigateway.com/docs/).

## Until @maxceem/cf-auth is on npm

The gateway temporarily uses the lockfile-recorded local dependencies
`file:../../maxceem/packages/cf-auth` and
`file:../../maxceem/services/cf-billing`. Until cf-auth is published, check out
the `maxceem` repository beside `calories-tracker` so the directory layout is:

```text
parent/
├── calories-tracker/app-ai-gateway/
└── maxceem/
    ├── packages/cf-auth/
    └── services/cf-billing/
```

Then run `pnpm install` from `app-ai-gateway`. The cf-auth package's `prepare`
script builds its ignored `dist/` automatically for local and Git installs, so
Worker typechecks, tests, and Wrangler bundling work from fresh checkouts. The
recorded `file:` dependencies are used instead of untracked global pnpm links.

### Break-glass operator recovery

Self-hosters can reset an operator password or promote an existing member to
owner with `scripts/recover-access.mjs`. The command refuses to choose a D1
target implicitly:

```sh
pnpm recover-access -- --email owner@example.com --password-stdin --remote < /secure/password-file
pnpm recover-access -- --email owner@example.com --promote-owner \
  --organization-id <organization-id> --remote
```

Add `--env production` when applicable. This invokes `wrangler d1 execute` and
does not print the password or hash. Prefer `--local` while validating a recovery
procedure; remote execution is an explicit owner-operated step.

### Migrating an ADMIN_TOKEN deployment

Existing deployments can create their first operator organization and backfill
legacy apps with `scripts/migrate-to-orgs.mjs`. The command requires an explicit
`--local` or `--remote` target; validate it with local D1 state before the owner
runs the documented production step. See the
[admin auth migration guide](https://docs.appaigateway.com/docs/auth-migration).

The checked-in Wrangler environments contain no personal domain or D1 ID.
Configure those deployment-specific values in your own environment, and keep
`SECRET_VAULT_LOCAL_KEK_V1` (or the `SECRET_VAULT_KMS_*` pair) in Worker secrets
rather than committing them.

### Optional cloud billing

The OSS configuration has no `BILLING` service binding and therefore grants
self-hosted access without subscription checks. A hosted environment can bind
the `BillingWorker` entrypoint from `cf-billing`; the commented example in
`wrangler.jsonc` shows the binding shape. The gateway scopes every RPC to
service `ai-gateway` and the authenticated organization ID.

Billing plan `limits_json` may define these ceilings:

```json
{ "maxApps": 25, "maxRpm": 500, "maxRpd": 10000, "maxMonthlyUsd": 250 }
```

With the binding present, inactive organizations receive stable
`402 payment_required` responses on the app data plane. RPC failures fail
closed without modifying or disabling application rows.

## OSS release checklist

- Publish `@maxceem/cf-auth` and replace its temporary local path with the npm
  version. Before distributing a standalone gateway checkout, also replace the
  `cf-billing` source path with a distributable billing contract package.
- Before publishing this repository, rewrite history before commit `0ecfd9a`.
  Older commits still contain a real domain, AI Gateway ID, D1 UUID, and obsolete
  `ADMIN_TOKEN` references even though none remain in the current tree.
- Re-run secret scanning against the rewritten history and rotate any value that
  was ever usable as a credential.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
