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

- `pnpm run check` — types across every project, plus generated-OpenAPI drift.
  About five seconds. Run it after every edit.
- `pnpm run test` — both test suites and the deploy-script tests, about a minute
  and a half. Run it when a change touches behaviour, and while working on one
  prefer the files that cover it:
  `pnpm exec vitest run test/<name>.test.ts` for the Worker, or
  `pnpm --filter @app-ai-gateway/console exec vitest run src/<path>.test.tsx`
  for the console. Do not use `vitest --changed`: nearly every test imports the
  shared routes, so it selects most of the suite anyway.
- `pnpm run verify` — both of the above, once, before a commit or hand-off. It
  costs essentially no more than `pnpm run test` alone, because the checks run
  alongside the suites rather than after them.

The Worker suite runs through the barrels in `test/suites`, which is what keeps
it near a minute: a test file costs about nine seconds to load before it runs a
single test, so the suite pays that nine times rather than thirty-nine. A new
test file has to be imported by one of them, and `pnpm run check` fails while it
is not. A barrel's members share one database, so a file that needs a clean one
belongs in a barrel of its own.

Do not verify a change by driving the app in a browser unless you are explicitly
asked to. The commands above are the expected evidence; a running app is the
author's to look at.

Two things `verify` does not cover: run `pnpm run deploy:dry-run` for Worker
configuration changes, and `pnpm run docs:build` when you change anything under
`docs/`, which is left out because it is slow and the gateway never imports it.

Type checking runs on `tsgo` (`@typescript/native-preview`), which is fast but
still a preview build. `pnpm run typecheck:tsc` checks the same projects on
`tsc` to confirm a diagnostic it reports, or fails to report, is real.
