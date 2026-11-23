# CLI compatibility policy

An installed `agw` outlives many gateway releases. This policy says what a
newer gateway promises to the `agw` releases already installed, and what
`agw` does with things it does not know. It starts with v2 (plan decision
D14). The v2 release itself breaks older CLIs on purpose: agw 2 manages v2
gateways only, and stops with a short message at a v1 gateway (use agw 1.x,
or migrate).

## What a newer gateway promises

From v2 on, every `agw` 2.x keeps working against every later v2 gateway:

1. **Additions only.** An API response, the app configuration and the tool
   list only gain optional fields. A field is never made required, never
   changes what it means, and is never removed while a released `agw` reads
   it.
2. **New settings only when used.** A new configuration field is written only
   when it differs from its default, so an older `agw` meets it only once
   somebody uses the feature. A new writable app setting goes inside
   `config`, because `agw` writes back only `name`, `config` and `status`.
3. **New enum values only where they are shown or stored.** A value that
   drives a client's control flow, such as an operation's `state`, needs a new
   field instead.
4. **The paths `agw` calls stay**: the OAuth server under `/v2/oauth/*` and
   its discovery document, `GET /v2/admin/session`, the operations the
   built-in commands call, and the tool list `GET /v2/cli/tools` with
   `POST /v2/cli/tools/{tool}`.
5. **New commands arrive as tools.** Most commands are not built into `agw`:
   the gateway lists its MCP tools, each with the command it is offered as,
   and `agw` builds the command from that. A gateway release adds commands
   without an `agw` release.
   A command that writes files to a folder is built in instead, because a
   tool's answer cannot carry them: `agw app conversations` calls the
   operations that list and download stored conversations, which are then
   among the paths in rule 4.

## What `agw` does with what it does not know

- **Unknown settings in an app's configuration** are kept exactly as sent
  and sent back when `agw` saves, and `agw` says once per run that the
  gateway is newer (`newer_gateway` notice). A command edits only what its
  flags name. Other unknown fields in an answer are left out of what `agw`
  prints, and a gateway command's result is printed as the gateway sent it.
- **A tool the gateway changed** is caught before it runs: every call sends
  the tool's guard, and a tool that has become destructive or needs more of
  `agw` is refused with `tool_changed`. `agw` then reads the gateway's current
  list and decides again, so it never runs a changed tool blind.
- **A tool that needs a newer `agw`** (its `requires` names a feature this
  release lacks) is left out of help and refused with "needs a newer agw".
- **A tool `agw` cannot read** is left out; the rest of the list still works.
- **The tool list is kept for a day**, and read again when a tool call
  answers with another revision, so a gateway deploy reaches an `agw` that
  ran a minute before it.

## What `agw` promises its own users

- `--json` prints one document with `schemaVersion: 1`; its fields only
  grow.
- Exit codes keep their meaning: 0 done, 2 the command line is wrong, 3 the
  gateway or the network failed, 4 a state or a decision stops it, 5 `agw`
  stopped waiting while the step is still open (as in agw 1.x). A wait timeout
  does not cancel a gateway operation: `agw operation wait` picks it up again.
  A browser sign-in that timed out cannot be picked up: run the command that
  started it again, or add `--device`.
- After a failure the gateway answered, `agw` compares its release with the
  one the gateway reports (`serverVersion` in `GET /v2/console/capabilities`)
  and, when they differ, adds a `version_mismatch` notice, as agw 1.x did: it
  carries `cliVersion` and `apiVersion`, and says which side to update. It is
  left out for a credential, permission, conflict or limit refusal (401, 403,
  409, 429), for an older hosted gateway (it is kept current for you), and
  for a gateway that does not report its release. A newer gateway is also
  noticed from fields `agw` does not know (`newer_gateway`), and a v1 gateway
  is refused with the agw 1.x message.
- `agw deployment status` shows the gateway's release, when the gateway
  reports it. agw 1.x also showed the price list's revision; a v2 gateway
  leaves it out until its deploy script records one.
- Secrets never reach stdout: a provider key comes from a hidden prompt,
  stdin or the console; a new app key goes to a private file.

## Differences from agw 1.x

agw 2 keeps most of agw 1.x's commands and flags. A few work differently:

- `agw app add --providers <slug>` allows the connection's first operation,
  as the console does when a connection is allowed. agw 1.x allowed all of
  them. Name the operations to allow more: `--providers <slug>=<operation>+<operation>`
  (`agw provider types` lists them).
- A Cloudflare AI Gateway is set on the connection itself:
  `agw provider add --cloudflare-account-id <id> --cloudflare-gateway-id <id> --browser`.
  There is no separate `provider-gateway` command. Its token is never a flag:
  the person approving the browser step enters it.
- `agw app snippet <app>` takes only the app. The gateway writes the examples
  for every route and preset the app has (agw 1.x took `--language`,
  `--provider`, `--endpoint` and `--output`).

## For contributors

Before changing anything `agw` reads, check it against the list above. A
change that breaks a released `agw` needs a new field or a new tool instead.
