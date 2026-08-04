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

| Variable | Value |
| --- | --- |
| `CF_AIG_GATEWAY_ID` | Your Cloudflare AI Gateway ID (slug) |
| `CF_AIG_TOKEN` | Its authenticated gateway token |
| `ADMIN_TOKEN` | A strong token you create for the admin console |

Get the values before deploying:

1. Open [Cloudflare AI Gateway](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fai%2Fai-gateway),
   create or select a gateway, and copy its exact **Gateway ID** into
   `CF_AIG_GATEWAY_ID`.
2. In that gateway's **Settings**, select **Create authentication token**. Save
   the one-time token and use it as `CF_AIG_TOKEN`; the generated token includes
   the required **AI Gateway Run** permission.
3. Generate and save your own admin token, then use it as `ADMIN_TOKEN`:

   ```sh
   openssl rand -base64 32
   ```

`JWT_SECRET` is generated automatically. Add model-provider credentials in the
AI Gateway **Provider Keys** page using the alias `default`; never put provider
keys in this repository or Worker variables.

For a manual deployment:

```sh
pnpm install
cp .dev.vars.example .dev.vars # fill in the three variables above
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
pnpm run db:seed:local
pnpm run dev
```

The Worker and admin console are available at `http://localhost:8787`; verify
the API with:

```sh
curl http://localhost:8787/v1/healthz
```

Run the full verification suite with `pnpm run check`. Configuration, client
integration, authentication, and API details are covered in the
[documentation](https://docs.appaigateway.com/docs/).
