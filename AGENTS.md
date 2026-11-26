# App AI Gateway

This is a minimal AI gateway (proxy) for applications. Its main purpose is to quickly and securely give applications access to AI providers, with one monthly request allowance per organization, and provide observability of AI usage inside all the applications from one place.

The primary target is iOS applications, with secure measures for calling AI APIs directly from an iOS app: App Attest, user auth verification, and paid entitlement verification. Support for server applications via API keys is complementary — it makes it possible to observe multiple applications from one place. Android applications are not supported yet, but are planned for the future.

## Main principles

- The main consumers of this gateway are individuals or teams who develop many small to medium load applications and want a fast, easy way to give their apps access to AI providers. Ease of use therefore takes priority over scalability.
- The main aim is to keep this project simple and easy to use without compromising security and performance. Security, performance, and ease of use are the top 3 priorities. The Security section below names our security priorities: where to focus, alongside normal security best practices.
- The project is distributed as an open-source, self-hosted project. It should be very easy to deploy for anyone who wants to self-host it.
- The project is also deployed as a hosted cloud version, so anyone who doesn't want to self-host can start using it right away. The cloud deployment process doesn't have to be as easy as the self-hosted one, but it must prioritize reliability and security for cloud customers.

## Serving requests

An app's users must never get a failed request because of a problem in the
gateway's own counting, pricing or billing. It is better to count a request
wrong than to fail it.

- **Check who is calling, always.** Serve a request only after the caller is
  verified: application key, App Attest, user auth, paid entitlement. If a
  check can't finish, refuse the request. The rules below never change this.
- **Refuse only for a deliberate reason.** These are the only good reasons:
  - the caller is not verified;
  - the app doesn't allow this provider, model or mode;
  - the customer's own limit for their app's users is reached;
  - the plan allowance is known to be used up.

  If the provider returns an error, pass it to the app as it is.
- **If counting or pricing breaks, serve the request anyway.** This covers
  usage recording, pricing, the allowance counter, billing lookups and
  analytics: if one fails, is slow or has no answer, serve the request and
  count it less precisely. This applies to the hosted version's billing too.
  Always log it as a `warn` or `error` so the monitor can alert on it. When
  the customer should know, also mark it on the usage event. Never miscount
  silently.
- **Don't make a request wait for counting.** Give counting a time limit, or
  do it after the response is sent.
- **Be strict when saving settings, and forgiving when serving requests.** When
  the customer saves an app or provider, check everything they name
  explicitly. Refuse to save a model or mode that has no price. If the plan
  can't be read, answer `503` instead of guessing. A mistake caught on save
  costs nothing. The same mistake caught on a live request fails real users.
- **Never start refusing something that used to work.** Refuse a request only
  if it could never have worked before. For example, a model without a price
  was never served, so refusing it breaks nothing. Anything that was served
  must keep being served:
  - never remove a price from the price list; mark it `unlisted_since`
    instead;
  - apply a new or stricter check when settings are saved, not to requests
    that already work.
- **When the exact price is unknown, estimate it. Never bill it as free.**
  Sometimes a request asks for something without an exact price, such as a
  service mode. Serve it, and bill it at the closest known price, never less
  than the model's standard price. Mark the event `cost_source: "estimated"`
  so the customer can see it.

## Code

- Read `ARCHITECTURE.md` before you add a table, Durable Object, Worker or
  binding, change where data is kept, change sign-in code or its imports,
  change request limits or the plan allowance, change a compatibility date,
  or change how the docs deploy.
- Every API operation is declared once in `src/contracts/catalog.ts`; the
  OpenAPI document, clients and server mounts derive from it. Never edit
  `openapi/openapi.json` manually; run `pnpm run openapi:generate` instead.
- Keep provider proxy bodies permissive: they preserve provider-native formats.

## Compatibility with older clients

An installed `agw` outlives many gateway releases, so a newer gateway must
never break an older CLI's work.

- Additions to API responses and the app configuration are additive and
  optional. Never make an existing field required, change what one means, or
  remove one that older clients read.
- Write a new configuration field only when it differs from its default, so
  older clients meet it only once the feature is used. Put a new writable app
  setting inside `config`: the CLI writes back only `name`, `config` and
  `status`.
- Add an enum value only where clients tolerate unknown values: a string they
  display or store. A value that drives a client's control flow, such as an
  operation's `state` or a protocol version, needs a new field instead.
- The CLI keeps and resends fields it does not know (`cli/src/tolerant.ts`).
  It edits only what a flag names, and asks before an `--file` update drops
  them. Add every new optional config field to `EVERY_OPTION` in
  `smoke/tests/deploy/management/cli.smoke.ts`, which published CLIs read and
  write back.

## Documentation changes

- Handwritten guides live in `docs/content/docs/`. Everything generated from
  them — `docs/content/docs/api/` and the machine files under `docs/public/` —
  is gitignored; never edit it. Keep `automation/agent-manual.mdx` free of MDX
  components: it is served verbatim as `/agents.md`.
- Never write "organization", "tenant" or "operator" in a guide, and do not
  document billing or plans there. Say "you", "your account" or "all your
  apps" instead.

## Security

Our security priorities, in order:

1. **Keep customers' provider keys safe.** A provider key entered where we
   ask for it is never readable by anyone else and is sent only where the
   customer chose.
2. **Serve an app only to its authorized callers.** A call is served only
   when it passes the app's own checks (App Attest, app key, user sign-in,
   paid entitlement) and stays within its limits. This protects the
   customer's provider usage.

Budgets and allowances are best effort: a small overrun is fine.

Rules that follow from these:

- Never print or commit provider keys, `BETTER_AUTH_SECRET`, vault keys
  (`SECRET_VAULT_LOCAL_KEK_*`, `SECRET_VAULT_KMS_TOKEN`), management keys,
  gateway application keys, or development credentials.
- Provider keys are per-organization rows in D1, encrypted through
  `src/vault/` [v2: sealed and opened only by the vault Worker, `v2/vault/`]. They are write-only: no response body may ever contain a
  submitted secret, only its `secretHint`.
- Use Wrangler secret commands, stdin, hidden prompts, or ignored local files for
  secret values. Do not place secret values in command arguments.
- Everything the optional `MANAGEMENT_ANALYTICS` dataset is written is declared
  in `src/analytics/management.ts`, built field by field there: constants and
  bounded tokens, never an error message, a request value or a credential.
  Never write it from the application request path.
- Everything the optional `ANALYTICS` binding is sent is declared in
  `src/analytics/hook.ts`, built field by field there. Never pass it anything
  else, and never call it from the application request path.

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
- `check`, `test` and `verify` stop a step that prints nothing for 5 minutes
  and fail it as a frozen run, naming the last test file it printed.
  `CHECK_SILENCE_MINUTES` changes the limit; `0` turns it off.
- `verify` does not cover Worker configuration (`pnpm run deploy:dry-run`, and
  `pnpm run deploy:prebuilt:dry-run` for the release's prebuilt deploy) or
  `docs/` (`pnpm run docs:build`).
- `smoke/` holds checks that run against a live deployment, not the code; see
  `smoke/README.md`. `verify` only typechecks them and runs the mock's offline
  tests. Each check is a contract with existing clients, and older releases'
  checks keep running against newer deployments: add a check for new
  behaviour, and change an existing assertion only when that contract changes
  on purpose, saying so in the pull request. Never print what `smoke/.state/`
  holds: it contains application keys.
- In tests, use `seedHuman` from `test/helpers.ts` rather than signing up, which
  costs about two and a half seconds.
- Vitest runs can record their results in a ledger (`scripts/test-ledger/`),
  which finds flaky, slow and never-failing tests over time. It writes nothing
  unless `TEST_LEDGER_DIR` is set or `~/.local/state/test-ledger/` exists. A
  test that stays on purpose although it never fails belongs in
  `scripts/test-ledger/keep.json`, with its reason.
- Do not verify a change by driving the app in a browser unless explicitly asked.
