# App AI Gateway CLI

The `@maxceem/agw` package provides the `agw` executable. Node.js 22.19 or newer is required. It includes the compatible gateway release and Wrangler toolchain; end users do not need Git, pnpm, a global Wrangler installation, or a repository checkout.

```sh
npx @maxceem/agw provider add --type openai
npx @maxceem/agw app add --type ios --team-id ABCDE12345 --bundle-id com.example.app
```

A fresh cloud connection creates your account only when adding a provider, provider gateway, or application. Help, lists, status, validation and dry runs never create accounts. Logout retains your selected deployment and prior account marker; invalid or revoked access requires login, with no automatic fallback or second account.

For automation, have a human supply a provider credential in their own browser:

```sh
agw provider add --type openai --browser --no-open --json
agw operation wait <operation-id> --timeout 300 --json
```

Share the returned URL. Hidden terminal input only prevents echo; an agent controlling that terminal can still observe it. The browser must be outside the agent's observable browser surface for credential isolation. Never pass credentials as command arguments. `--key-stdin` explicitly reads a single secret line. `--no-input` prohibits terminal prompts, and `--no-open` returns a browser operation without waiting.

Run `agw --help` for the complete command surface and `agw <group> <command> --help` for its flags. Resource IDs and slugs are exact; display names are not selectors. File outputs never overwrite existing files. Server application keys are written with mode 0600 and never included in stdout. If persistence fails, the CLI attempts immediate revocation and reports the key ID for recovery.

Application JSON uses the gateway's shared complete write schema (`name`, `config`, optional `status`). Derive an editable definition from a saved app with `agw app show <app-id> --json | jq '.result.app | {name, config, status}'`; `app validate --file` and `app add --file --dry-run` validate it without account creation. Offline validation reports skipped remote checks. File mode preserves omission of App Attest environments; the simple iOS flags explicitly enable production and development. Application updates require the original ETag in `If-Match`; conflicting edits return an error instead of overwriting changes. Retained selected providers keep their detailed policies.

Swift snippets use the current package at `https://github.com/maxceem/app-ai-gateway-swift` (from version 1.0.0), actual application/provider IDs, and the saved authentication mode. Issuer examples require replacing the indicated identity SDK call. Requests still need a provider-native body and must be sent by the caller. No setup or readiness check sends paid inference or proves physical-device attestation.

## Output and state

`--json` emits exactly one JSON document to stdout. Progress goes to stderr. The result envelope is `{schemaVersion:1,ok:true,context:{url,accountId?,deploymentId?},result}`. Errors are `{schemaVersion:1,ok:false,error:{code,message,nextAction,details?}}`. Unknown remote fields are excluded from output; complete validated application config preserves provider-native endpoint parameters.

Exit statuses: `0` success (including pending handoff initiation), `2` input/validation error, `3` remote/connectivity or failed handoff, `4` local state/recovery/authentication issue, `5` wait timeout. Timeout includes still-pending operation metadata and does not cancel or extend the server operation. Poll authorization is stored separately from public operation IDs/URLs. Authentication handoff completion is persisted before output, and replay cannot undo a logout or later connection switch.

State is `$XDG_STATE_HOME/agw` or `~/.local/state/agw` on Unix, and `%LOCALAPPDATA%/agw` on Windows. The directory is mode 0700 and files are mode 0600. It contains one active connection, the previous connection for intentional recovery, pending operations, creation retry proofs, application keys, and protected installation journals. No public profile selectors or gateway credential environment overrides exist. Back up this directory securely. Concurrent commands use an exclusive lock; after a crashed process, inspect the PID in `connection.lock` before removing that lock. Never delete connection state merely to resolve an authentication error.

Public API URLs require HTTPS, no userinfo, query, fragment or path. Only `localhost`, `127.0.0.1` and `[::1]` permit HTTP for local development. Authenticated HTTP redirects are refused. Connecting authenticates only to the requested origin and selects it after success.

## Self-hosting

```sh
agw deployment setup --name my-gateway --no-domain
agw deployment update --dry-run
agw deployment domain --hostname ai.example.com --dry-run
```

Setup obtains Cloudflare authorization using bundled Wrangler OAuth, or accepts standard securely configured Cloudflare credentials such as `CLOUDFLARE_API_TOKEN`. If more than one Cloudflare account is accessible, choose one with `--cloudflare-account-id`. Noninteractive mutations require explicit configuration and `--yes`; `--yes` does not grant Cloudflare permissions or approve browser identity ceremonies.

The npm package contains a versioned Worker bundle, console assets, migrations, configuration, and SHA-256 manifest. npm package integrity authenticates the package; local manifest/file digests detect corrupt assets before deployment. `--version` selects only the bundled compatible release; use the matching CLI package version for another release. No unversioned source download or arbitrary downgrade is performed. Release format/schema versions are checked before mutation.

Installation journals are written before creating resources, keep generated vault/signing/bootstrap secrets across retries, and bind the Cloudflare account, Worker, D1 database and immutable deployment ID. A Worker name collision never authorizes takeover. Retry an incomplete setup with the same name/account; its previous active gateway connection remains selected until bootstrap succeeds. A completed setup does not replay retired bootstrap credentials or overwrite subsequently rotated secrets. Updates preserve existing secrets and reject unsupported schema transitions. Database migrations do not have an automatic rollback.

A URL-only connection can be matched interactively to an explicitly selected accessible Worker only when its Cloudflare `DEPLOYMENT_ID` matches the gateway. Unsupported extra resource bindings fail rather than being discarded. Noninteractive deployment administration needs the existing installation journal. Dry runs discover/validate only; they do not provision resources, generate/upload secrets, change DNS, bootstrap accounts or select connections.

Custom domains require an accessible active zone. Existing unrelated DNS or Worker domain attachments are refused. The new endpoint must identify the same deployment before credentials follow it. Existing hostnames remain served; mobile applications keep their embedded URL until updated. Changing from cloud to self-hosting does not migrate app IDs, provider credentials, usage or existing applications.

## Release verification for contributors

`pnpm run cli:check` type-checks the CLI with `tsgo` and then bundles the portable schemas and executable. `pnpm run cli:test` runs parser, state, transport, command and mocked deployment tests; both are included in root verification. `pnpm --filter @maxceem/agw release:build` builds the actual deployable bundle locally. `npm pack` runs that release build and packages only `dist`, this README and the Apache-2.0 license. Verify the tarball and invoke its installed executable outside the repository before publishing. Publishing and live Cloudflare operations are separate release decisions.

Creation retries persist a request proof before sending provider, gateway, app or application-key creation. Repeating an unfinished saved request returns its original result. After successful output delivery, its local pending receipt is acknowledged, so a later invocation is a new intentional creation. A server key response can be recovered remotely for 15 minutes; after that, the error identifies the existing resource so you can inspect and replace its key intentionally. Non-secret receipt records prevent duplicate creation for the lifetime of the account. An unfinished local request older than 90 days refuses to submit again automatically.

The CLI saves a one-time key response in protected local state before writing the selected `--key-output` file. If the file write fails, repeat the same command to complete that file, or choose a new unused output path; this uses the saved active key and does not mint another. Once file delivery completes, the recovery copy is removed; a retry before successful command output verifies that original file. After stdout delivery is acknowledged, a later key creation is a new request and requires a new unused output file. Existing unrelated files and replaced output reservations are never overwritten.

Unfinished bootstrap attempts also have a 90-day local retry deadline. Missing or expired timestamps fail closed and preserve the proof for recovery. Server cleanup retains only a non-secret, proof-bound bootstrap tombstone after deleting an expired account, so an old retry cannot recreate that account. The tombstone contains no account identity or credential and is intentionally retained beyond ordinary challenge expiry.
