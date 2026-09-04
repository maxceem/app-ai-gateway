# App AI Gateway

This is a minimal AI gateway (proxy) for applications. Its main purpose is to quickly and securely give applications access to AI providers, with one monthly request allowance per organization, and provide observability of AI usage inside all the applications from one place.

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

`pnpm run check` does not build the documentation site: the build is slow and the
gateway never imports it. `pnpm run docs:deploy` builds before it publishes, so a
broken docs build fails there rather than silently shipping. When you change
anything under `docs/`, run `pnpm run docs:build` yourself before handing off.

The `packageManager` pin stays at `pnpm@11.0.4`: it is the last release whose
`@pnpm/exe` ships a macOS x64 binary, and pnpm refuses to run a version it
cannot download. Raising it breaks every command on an Intel Mac.

<!-- t3dev:begin -->
## Local preview deployment

This repository is served locally while you work. Each T3 Code worktree gets its
own dev server on its own port, reverse-proxied by Caddy under `*.localhost`.

- `dev-up` starts (or refreshes) the preview for the current worktree and
  prints its URLs. It is safe to run repeatedly.
- `dev-up --print-url` prints just the URLs, newest-name first.
- `dev-down` stops the preview for the current worktree.
- If a command is blocked by a sandbox, run `dev-up --marker` instead: it only
  writes a `.t3-devup` file, and the background reconciler performs the deploy.

Two URLs point at the same server:

- a **stable** one derived from the worktree directory, valid from the moment
  the worktree exists;
- a **branch** one derived from the branch name, which appears once T3 Code has
  renamed the temporary `t3code/<hex>` branch to a descriptive one.

Guidelines:

- After changing anything a reviewer should see, make sure the preview is up and
  mention the branch URL so it can be opened directly.
- Before creating a pull request, rebase onto the latest base branch:
  `git fetch origin && git rebase origin/main` (use the repository's actual
  default branch). Resolve conflicts before opening the PR.
- **Include the preview URL in the pull request body**, on its own line, for
  example: `Preview: http://my-branch.my-app.localhost:8080`.
- Do not call the Caddy admin API directly; always go through `dev-up` /
  `dev-down`.

The preview is torn down automatically once the pull request is merged (or the
thread is deleted), so there is nothing to clean up by hand.
<!-- t3dev:end -->
