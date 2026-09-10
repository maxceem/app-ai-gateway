# App AI Gateway

This is a minimal AI gateway (proxy) for applications. Its main purpose is to quickly and securely give applications access to AI providers, with one monthly request allowance per organization, and provide observability of AI usage inside all the applications from one place.

There are two unrelated quota systems, and conflating them has broken this project once already. The **plan allowance** (`billing_*` codes, `src/do/OrgQuota.ts`) meters an organization against what it pays for. **Application limits** (`app_*` codes, `src/do/UserLimiter.ts`) are what an organization sets on its own app's end users. Neither reads the other, app limits are checked first, and no plan value may cap what an organization grants its users.

The primary target is iOS applications, with secure measures for calling AI APIs directly from an iOS app: App Attest, user auth verification, and paid entitlement verification. Support for server applications via API keys is complementary — it makes it possible to observe multiple applications from one place. Android applications are not supported yet, but are planned for the future.

## Main principles

- The main consumers of this gateway are individuals or teams who develop many small to medium load applications and want a fast, easy way to give their apps access to AI providers. Ease of use therefore takes priority over scalability.
- The main aim is to keep this project simple and easy to use without compromising security and performance. Security, performance, and ease of use are the top 3 priorities.
- The project is distributed as an open-source, self-hosted project. It should be very easy to deploy for anyone who wants to self-host it.
- The project is also deployed as a hosted cloud version, so anyone who doesn't want to self-host can start using it right away. The cloud deployment process doesn't have to be as easy as the self-hosted one, but it must prioritize reliability and security for cloud customers.

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
- Deploy documentation with `pnpm run docs:deploy`. A custom domain belongs in
  a gitignored `docs/wrangler.<profile>.overlay.jsonc`, never in the tracked
  config; deploy it with `pnpm run docs:deploy --profile <name>`.

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

Verification is tiered by cost. Do not run the full check after every edit.

- After each edit, run `pnpm run check:fast`. It type-checks every project and
  checks the generated OpenAPI document for drift in a few seconds.
- When a change touches behaviour, run only the test files that cover it, by
  path: `pnpm exec vitest run test/<name>.test.ts` for the Worker, or
  `pnpm --filter @app-ai-gateway/console exec vitest run src/<path>.test.tsx`
  for the console. A single file finishes in seconds to tens of seconds; the
  full suites take about two minutes because every worker boots the Workers
  runtime and replays the D1 migrations. Do not use `vitest --changed`: nearly
  every test imports the shared routes, so it selects most of the suite anyway.
- Before a commit or hand-off, run `pnpm run check` once. It runs everything
  above plus both test suites and the deploy-script tests.

For Worker configuration changes, also run `pnpm run deploy:dry-run` and
regenerate binding types when applicable.

Type checking runs on `tsgo` (`@typescript/native-preview`, the Go port of
TypeScript), which checks these projects several times faster than `tsc`. It is
still a preview build, so `pnpm run typecheck:tsc` checks the same three
projects on `tsc` instead — use it to confirm a diagnostic `tsgo` reports, or
fails to report, is real. The console's production build
(`pnpm run console:build`) still goes through `tsc`, so the deploy path keeps
checking against the reference compiler either way.

`pnpm run check` does not build the documentation site: the build is slow and the
gateway never imports it. `pnpm run docs:deploy` builds before it publishes, so a
broken docs build fails there rather than silently shipping. When you change
anything under `docs/`, run `pnpm run docs:build` yourself before handing off.
