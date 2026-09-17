# App AI Gateway CLI

`agw` sets up and manages [App AI Gateway](https://appaigateway.com/)
from a terminal or a coding agent: providers, apps, usage, and your own
deployment. Requires Node.js 22.19+.

```sh
npm install -g @maxceem/agw
```

## Quick start

Sign in with a management key. Create one in the console at
[appaigateway.com](https://appaigateway.com/): user menu, then **Management keys**.

```sh
agw account login
```

No account yet? Skip login. A free anonymous account is created for you
automatically as soon as you add your first provider or app below. You can
claim it later with `agw account claim`.

Add a provider. Paste its API key into the hidden prompt.

```sh
agw provider add --type openai
```

Add an app. It uses every provider you have added. A server app is created with
an application key, written to a private file; an iOS app authenticates with
App Attest instead and ships no key.

```sh
agw app add --type server --name "My backend"
agw app add --type ios --team-id ABCDE12345 --bundle-id com.example.app
```

Creating an app prints the request it can send. To print it again — as curl for
a server app, as Swift for an iOS one:

```sh
agw app snippet <app-id>
agw app snippet <app-id> --provider openai   # when several could serve it
```

The example is written from the app's own providers and models, and uses named
placeholders such as `PROVIDER_SLUG` for anything not configured yet.

## Self-host on Cloudflare

The package drives Wrangler and installs the gateway release of its own version.
No checkout needed. The gateway itself downloads once from the project's GitHub
release and is cached, after the CLI matches it against a digest built into the
executable.

```sh
agw deployment setup --name my-gateway --no-domain   # deploy and connect
agw deployment update                                 # move to this CLI's release
agw deployment domain --hostname ai.example.com       # attach a custom domain
```

Setup signs in to Cloudflare through Wrangler, or uses `CLOUDFLARE_API_TOKEN`
if set. Add `--dry-run` to any of these to see what would happen. See the
[self-hosting guide](https://docs.appaigateway.com/self-hosting/deploy-to-cloudflare).

No route to GitHub from that machine? Fetch the `gateway-<version>.tar.gz` asset
elsewhere and pass `--release-archive <path>`.

## Commands

| Group | What it manages |
| --- | --- |
| `provider` | Provider credentials: `add`, `list`, `show`, `update`, `rotate-key`, `remove` |
| `provider-gateway` | Cloudflare AI Gateway in front of a provider |
| `app` | Apps and their config: `add`, `list`, `show`, `update`, `validate`, `check`, `snippet`, `remove`, `key` |
| `usage` | Spend and requests: `show`, `breakdown` |
| `account` | `status`, `claim`, `login`, `logout` |
| `deployment` | `setup`, `connect`, `status`, `update`, `domain` |
| `operation` | `status` and `wait` for browser handoffs |

`agw --help` lists every command; `agw <group> <command> --help` lists its flags.

## Using `agw` from an agent

Full guide: [docs.appaigateway.com/automation/cli](https://docs.appaigateway.com/automation/cli).
The whole documentation is also published as
[agents.md](https://docs.appaigateway.com/agents.md).

**Output.** Add `--json` for exactly one JSON document on stdout; progress goes
to stderr. Without `--json`, output is plain text and a failure is printed to
stderr, so stdout carries only the command's own output. Add `--no-input` to
fail instead of prompting.

```json
{ "schemaVersion": 1, "ok": true,  "context": { "url": "...", "accountId": "..." }, "result": { } }
{ "schemaVersion": 1, "ok": false, "error": { "code": "...", "message": "...", "nextAction": "...", "details": { } } }
```

Every error names a `code` and a `nextAction`. Follow the `nextAction`.

| Exit | Meaning |
| --- | --- |
| `0` | Success, including a browser handoff that is still pending |
| `2` | Invalid input or validation failure |
| `3` | Gateway unreachable, remote error, or failed handoff |
| `4` | Local state or authentication problem |
| `5` | `operation wait` timed out; the operation is still pending |

**Secrets.** Never put a key in a command argument. Either pipe it with
`--key-stdin`, or hand the browser to a human:

```sh
agw provider add --type openai --browser --no-open --json   # prints a URL
agw operation wait <operation-id> --timeout 300 --json      # resumes when done
```

Share the URL with the person who holds the credential. Nothing typed on that
page reaches the CLI or its output.

**Editing apps.** Read before you write. `app show --json` returns the full
config; save `{name, config, status}` from `result.app`, edit it, and pass it
back with `app update <id> --file`. A concurrent change is rejected rather than
overwritten. `app validate --file` checks a file without touching the account.

**State.** Connection, credentials and pending operations live in
`~/.local/state/agw` (`$XDG_STATE_HOME/agw`, or `%LOCALAPPDATA%/agw` on
Windows), mode 0700. Do not delete it to fix an authentication error; run
`agw account login` instead. Output files are never overwritten.

## Local development

The source lives in `cli/` of the
[main repository](https://github.com/maxceem/app-ai-gateway). Clone it and run
`pnpm install`.

From the repository root, `pnpm cli:dev` is `agw` built from your own source
instead of an installed copy. It rebuilds before every run, so your latest edit
is always the one that runs.

```sh
pnpm cli:dev account login
pnpm cli:dev provider add --type openai
pnpm cli:dev app list
```

It keeps its state in `.agw-dev/`, separate from the state an installed `agw`
uses. To start again from nothing:

```sh
pnpm cli:dev:reset
```

Deploying needs the gateway itself built too, once per change to the Worker,
console or migrations:

```sh
pnpm --filter @maxceem/agw release:build
pnpm cli:dev deployment setup --name my-gateway --no-domain
```

Type-check and test:

```sh
pnpm run cli:check
pnpm run cli:test
```

## License

This project is licensed under the [Apache License 2.0](LICENSE).
