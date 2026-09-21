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

- Treat `src/contracts/schemas.ts` as the source for public request schemas,
  `src/contracts/responses.ts` for response bodies, and
  `src/contracts/openapi.ts` as the source for documented operations.
- `AppConfigSchema` in `src/contracts/schemas.ts` is the only parser of an
  application configuration, and its output is what is stored. The server, the
  console and the CLI all reach it through `parseAppConfig` in
  `src/shared/app-config.ts`, which is also the one place a rejection is worded.
  Add a rule there and nowhere else; a check written beside a caller is a second
  grammar, and this project has had one before.
- `src/contracts/operations.ts` is the descriptor table the console and the CLI
  both call through: method, path builder, request and response types. It is
  runtime-light and imports every schema with `import type`; the runtime schemas
  the CLI parses with live in `src/contracts/operation-schemas.ts`, which only
  the CLI loads. Adding an endpoint either client uses means adding an entry to
  both.
- Answer a documented response with `satisfies` on its inferred type, so the
  handler fails `pnpm run check` when it drifts from its own document. Never add
  runtime parsing to a server response.
- Never edit `openapi/openapi.json` manually.
- Run `pnpm run openapi:generate` after changing a route contract.
- Run `pnpm run openapi:check` to detect generated-document drift.
- Keep provider proxy bodies permissive: they preserve provider-native formats.
- Add runtime validation from the shared schema when accepting a documented body.

## Documentation changes

- Handwritten guides live in `docs/content/docs/`.
- Generated endpoint pages under `docs/content/docs/api/` are ignored and replaced
  by `docs/scripts/generate-api.mjs`; never edit them.
- `docs/scripts/generate-machine-files.mjs` publishes the guides for machines
  before every docs build: `llms.txt`, `llms-full.txt`, `agents.md`, a `.md`
  copy of each page and `openapi.json` under `docs/public/`. They are
  gitignored; never edit them, and keep `automation/agent-manual.mdx` free of
  MDX components because it is served verbatim as `/agents.md`.
- Never write "organization", "tenant" or "operator" in a guide, and do not
  document billing or plans there. Say "you", "your account" or "all your
  apps" instead.
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
- `pnpm run test` — both test suites and the deploy-script tests, about a
  minute. Run it when a change touches behaviour, and while working on one
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

A test that needs an authenticated human should call `seedHuman` from
`test/helpers.ts`, not sign one up: signing up hashes a password with a pure-JS
scrypt and costs about two and a half seconds. Sign up only where registering is
what the test is about.

Do not verify a change by driving the app in a browser unless you are explicitly
asked to. The commands above are the expected evidence; a running app is the
author's to look at.

Two things `verify` does not cover: run `pnpm run deploy:dry-run` for Worker
configuration changes, and `pnpm run docs:build` when you change anything under
`docs/`, which is left out because it is slow and the gateway never imports it.

Type checking runs on `tsgo` (`@typescript/native-preview`), which is fast but
still a preview build. `pnpm run typecheck:tsc` checks the same projects on
`tsc` to confirm a diagnostic it reports, or fails to report, is real.

## Releasing

Only the project owner releases. Contributors send pull requests, and nothing a
pull request changes can release or deploy anything: releases are cut from
`vX.Y.Z` tags, creating one is restricted to the owner by a repository ruleset,
and CI fails a pull request that edits a version field. Do not add a
contributing guide or release instructions aimed at anyone else.

One command, on a clean and up-to-date `main`:

```sh
pnpm run release 0.1.8            # add --dry-run to print the plan and write nothing
pnpm run release 0.1.8 --breaks-upgrades   # when this release cannot migrate the previous one's database
```

`scripts/release.mjs` sets the version in `package.json` and `cli/package.json`,
prepends the previous version to `upgradeFrom`, runs `pnpm run check`, commits
`Release 0.1.8`, tags `v0.1.8` and pushes the commit and the tag atomically.
The tag triggers `.github/workflows/release.yml`, which verifies, publishes the
gateway archive to the GitHub release, deploys the Worker with the `cloud`
profile, publishes `@maxceem/agw` to npm and deploys the documentation. Its
header comment lists the repository secrets it needs; npm uses trusted
publishing configured on npmjs.com for this repository and workflow file, so
no npm token exists anywhere.

Rolling back: `wrangler rollback` returns a Worker to its previous version, but
a D1 migration is forward-only, so ship a fix release instead. A published npm
version cannot be replaced; `npm deprecate` it and release the fix.
