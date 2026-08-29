# Agent workflow

This repository contains a Cloudflare Worker, React administration console, and
Fumadocs documentation application. Use Node.js 22+ and the pinned pnpm version.

## API contract changes

- Treat `src/contracts/schemas.ts` as the source for public request schemas and
  `src/contracts/openapi.ts` as the source for documented operations.
- Never edit `openapi/openapi.json` manually.
- Run `pnpm run openapi:generate` after changing a route contract.
- Run `pnpm run openapi:check` to detect generated-document drift.
- Keep provider proxy bodies permissive: they preserve provider-native formats.
- Add runtime validation from the shared schema when accepting a documented body.

## Documentation changes

- Handwritten guides live in `docs/content/docs/`.
- Generated endpoint pages under `docs/content/docs/api/` are ignored and replaced
  by `docs/scripts/generate-api.mjs`; never edit them.
- Build docs separately with `pnpm run docs:build`. Do not add Fumadocs code or
  dependencies to the deployed gateway Worker.
- Keep the production docs deployment static-only. Do not add route handlers,
  SSR, OpenNext, `run_worker_first`, or a Worker `main` entry without explicit
  approval; those would introduce Worker invocations and billing.
- Deploy documentation with `pnpm run docs:deploy`. Its custom domain is
  `docs.appaigateway.com`.

## Security

- Never print or commit provider keys, `BETTER_AUTH_SECRET`, vault keys
  (`SECRET_VAULT_LOCAL_KEK_*`, `SECRET_VAULT_KMS_TOKEN`), management keys,
  gateway application keys, or development credentials.
- Provider keys are per-organization rows in D1, encrypted through
  `src/vault/`. They are write-only: no response body may ever contain a
  submitted secret, only its `secretHint`.
- Use Wrangler secret commands, stdin, hidden prompts, or ignored local files for
  secret values. Do not place secret values in command arguments.

## Verification

Run `pnpm run check` before handing off a change. For Worker configuration changes,
also run `pnpm run deploy:dry-run` and regenerate binding types when applicable.
