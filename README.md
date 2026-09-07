# App AI Gateway

Protect your AI providers inside iOS apps. Keep provider keys off the device,
verify every request with Apple App Attest, and see usage, cost, and limits per
user. Runs on your own Cloudflare account.

**[Documentation](https://docs.appaigateway.com/)** ·
**[API reference](https://docs.appaigateway.com/api/)**

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxceem/app-ai-gateway)

A Cloudflare account is all you need. The deployment form asks for one value:

| Variable | How to obtain it |
| --- | --- |
| `SECRET_VAULT_LOCAL_KEK_V1` | Run `openssl rand -base64 32`. It encrypts the provider keys you add later in the console, so back it up — losing it makes them unreadable. |

Everything else is provisioned for you. When the deployment finishes, open the
console, create the first account, and add your provider keys.

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

The gateway and console run at `http://localhost:8787`.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
