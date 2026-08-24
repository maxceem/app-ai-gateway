# App AI Gateway

A multi-tenant LLM proxy for Cloudflare Workers. It keeps provider keys out of
client applications and supports OpenAI, Anthropic, xAI, Gemini, and Perplexity.

**[Documentation](https://docs.appaigateway.com/docs/)** ·
**[API reference](https://docs.appaigateway.com/docs/api/)**

## Deploy

Requirements: a Cloudflare account and an existing
[Cloudflare AI Gateway](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fai%2Fai-gateway).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxceem/app-ai-gateway)

The deployment form provisions the Worker, D1 database, Durable Object, admin
console, and future deployments. It requires:

| Variable | How to obtain it |
| --- | --- |
| `CF_AIG_GATEWAY_ID` | [Create or select an AI Gateway](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fai%2Fai-gateway), then copy its exact **Gateway ID** (slug). Deployment does not create one. |
| `CF_AIG_TOKEN` | In that gateway, open **Settings → Create authentication token**. Save the one-time token; it includes **AI Gateway Run** permission. |
`JWT_SECRET` and `BETTER_AUTH_SECRET` are generated automatically. After the
first deployment, create the initial operator account at `/v1/auth/sign-up/email`.
Set `ALLOW_PUBLIC_REGISTRATION=false` after bootstrapping a private deployment.
Add model-provider credentials in the
AI Gateway **Provider Keys** page using the alias `default`; never put provider
keys in this repository or Worker variables.

For a manual deployment:

```sh
pnpm install
cp .dev.vars.example .dev.vars # fill in the two variables above
pnpm run secrets:upload
pnpm run deploy
```

## Run locally

Requirements: Node.js 22+, pnpm 11, Wrangler 4, and access to the Cloudflare AI
Gateway configured in `.dev.vars`.

```sh
pnpm install
cp .dev.vars.example .dev.vars
# Set CF_AIG_GATEWAY_ID and CF_AIG_TOKEN in .dev.vars
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

### Local cf-auth dependency

Until `@maxceem/cf-auth` is published, this checkout uses the lockfile-recorded
`file:../../maxceem/packages/cf-auth` dependency. Keep the gateway and `maxceem`
repositories in that relative layout and run `pnpm --dir ../../maxceem/packages/cf-auth build`
before installing or bundling the gateway. A `file:` dependency is used instead
of an unrecorded global pnpm link so installs and Wrangler resolution are repeatable.

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

The checked-in Wrangler environments contain no personal domain, D1 ID, or AI
Gateway ID. Configure those deployment-specific values in your own environment;
keep `CF_AIG_GATEWAY_ID` and `CF_AIG_TOKEN` in secrets/variables rather than
committing them.

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

## License

This project is licensed under the [Apache License 2.0](LICENSE).
