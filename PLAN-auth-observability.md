# Plan: Auth observability — granular issuer errors, auth event log, claim-propagation metrics, console errors view

Status: approved, ready for implementation.
Scope: this repository (`app-ai-gateway`), including the Swift client package in `ai-gateway-swift/`.
Companion document: `calories-tracker-app/PLAN-adopt-gateway-auth-codes.md` (iOS app changes, applied after this plan ships).

---

## 1. Why we are doing this

### The incident that motivated it

The gateway authenticates end users by exchanging an **issuer token** (a Firebase Auth ID token) for a short-lived gateway token (`POST /:app/auth/token`, TTL 3600s). App configs can demand `required_claims` — e.g. the calorie-tracker app requires a `pro` entitlement claim that a RevenueCat→Firebase extension writes asynchronously after a purchase.

In production, a real user purchased a subscription, but the claim took longer to propagate than the client's retry window. The gateway rejected every token exchange during that gap with the same opaque `403 issuer_token_rejected` it uses for forged, expired, or malformed tokens. Two systemic gaps made this incident invisible and undiagnosable from the server side:

1. **GatewayErrors are never logged.** The `app.onError` handler in `src/index.ts` serializes `GatewayError` to the client and returns — only non-GatewayError exceptions get a log line (`unhandled_error`). A user being rejected repeatedly produces zero log output, even though Workers Logs is enabled at 100% head sampling in `wrangler.jsonc`.
2. **One opaque error for ~9 distinct causes.** `verifyIssuerToken` (`src/core/issuer.ts`) throws the identical `GatewayError(403, "issuer_token_rejected", ...)` for: JWKS fetch failure, invalid JWKS, unknown `kid`, disallowed algorithm, bad signature, expired token, excessive lifetime, **missing required claims** (the incident — an otherwise *valid* token), and missing user-id claim. The one *expected, transient* cause is indistinguishable from an attack, a config error, or an upstream outage — for the operator **and** for the client, which cannot decide whether to re-authenticate or simply wait.

### The product goal

This gateway is multi-tenant (organizations → apps → users). Any tenant whose app uses claim-based issuer auth will eventually hit the same class of problem. So the fix is built as **general gateway functionality, surfaced in the customer console**, not as a one-off for the calorie tracker:

- Structured logs of every business error (operator debugging floor).
- A durable, per-app **auth event log** in D1, sibling to the existing `app_usage_event` table (customer-visible history).
- A first-class **claim-propagation delay** metric (time from first "claim missing" rejection to first successful exchange per user).
- A console **"Auth & Errors"** view per app.

### Design decisions already made (do not relitigate)

- **Error codes follow client behavior, not internal cause.** New code only when the client should act differently; fine-grained cause is a log-only `reason`. Three behavior classes (see §3.1).
- **New codes ship immediately** (no transitional legacy-code emulation). Known accepted trade-off: already-installed iOS builds match on `issuer_token_rejected` for auto-recovery; they will show the server's error message for the claim-gap case until users update. Therefore the `issuer_claims_missing` message must read well standalone.
- **Sibling table, not a merge into `app_usage_event`.** The usage table is a financial fact table (repriced, summed for cost reports) with NOT NULL `model`/`route`/`provider_type`/`user_id` that don't fit auth events; relaxing them is a rebuild of a populated financial table. Auth events also want different retention (prune at 90 days vs. keep-forever billing history).
- **No Analytics Engine / no new infrastructure.** Everything lives in D1 + Workers Logs.
- **Console UI ships in the same effort** as the data layer.

---

## 2. Current state — facts an implementer needs

- Stack: Cloudflare Workers, Hono, D1 via drizzle (`src/db/schema.ts`), migrations as numbered SQL in `migrations/` (latest: `0018_serious_expediter.sql`), generated with `pnpm db:generate` (drizzle-kit). Tests: vitest in `test/` (see `test/auth.test.ts`, `test/apply-migrations.ts`). Full gate: `pnpm check` (typecheck + openapi:check + vitest + console tests + docs build).
- `src/core/errors.ts`: `ErrorCode` string union (includes `issuer_token_rejected`), `class GatewayError extends Error { status, code, message, headers? }`, `errorResponse()` serializing `{ error: { code, message } }`.
- `src/core/issuer.ts`: `verifyIssuerToken(token, config, options?)` — all rejection paths call a shared `reject()` (line ~70) or throw inline (JWKS paths, lines ~26–34). Verification order today: header checks → JWKS/kid lookup (with refetch on unknown kid) → `jwtVerify` (signature) → `exp`/`iat`/lifetime checks → `required_claims` check (skippable via `options.skipRequiredClaims`) → user-id claim extraction. **Note:** the user id is extracted *after* the required-claims check; Phase 1 reorders this (§3.1).
- `src/index.ts` `app.onError`: returns `errorResponse(...)` for `GatewayError` with **no logging**; logs only unexpected errors as `unhandled_error`. Logger: `src/core/log.ts` — `log(level, message, fields)` printing one JSON line.
- `src/routes/auth.ts`: `POST /:app/auth/challenge`, `/register` (App Attest key registration; calls `verifyIssuerToken`), `/token` (two branches: `api_key` + issuer, and App Attest assertion + issuer; both call `verifyIssuerToken`). `app_user` upserts via `storeIssuerUser` / `storeAttestedUser`.
- `src/db/schema.ts`: `app_usage_event` is the pattern to copy — idempotent nullable-unique `event_id`, `(app_id, created_at)` and `(app_id, user_id, created_at)` indexes, unconstrained-text columns for growable value sets (see `cost_source` comment explaining why: CHECKs force table rebuilds).
- `src/core/usage.ts`: `recordUsageEvent()` — fire-and-forget recording inside `waitUntil` with idempotent retries; copy this pattern for auth events.
- No `scheduled` handler and no cron triggers exist yet (needed for pruning, §3.2).
- Console: React app in `console/`, per-app tabs in `console/src/pages/tabs/` (`usage.tsx` + `usage.test.tsx` are the pattern); console API routes in `src/routes/console.ts`.
- OpenAPI: `scripts/generate-openapi.ts` + `pnpm openapi:check` — new error codes and any new console endpoints must be reflected and the spec regenerated (`pnpm openapi:generate`).
- Swift client (`ai-gateway-swift/Sources/AIGateway/`): `GatewayError.swift` defines `GatewayErrorCode: String, Codable` including `issuerTokenRejected = "issuer_token_rejected"` and a `.unknown` fallback (`AIGatewayClient.swift:341` maps unrecognized raw codes to `.unknown`, so old clients degrade gracefully). `AIGatewayClient.swift:204`: on `.issuerTokenRejected` with `retryIssuerOnce`, calls the app-supplied `issuerRejectionRecovery` closure, then retries once with a force-refreshed issuer token.

---

## 3. Implementation

### Phase 1 — Error taxonomy + structured logging

#### 3.1 `src/core/issuer.ts` — reasons and behavior-class codes

Add a `reason` to every rejection. Reason values (log/event-only vocabulary; free to extend later):

`jwks_unreachable`, `jwks_invalid`, `header_invalid`, `unknown_kid`, `alg_mismatch`, `bad_signature`, `timestamps_invalid`, `expired`, `lifetime_exceeded`, `claims_missing`, `user_id_missing`.

Map reasons to **three client-facing codes** (the behavior classes):

| Behavior class | Reasons | Status + code | Client's correct action |
|---|---|---|---|
| Token invalid | `header_invalid`, `unknown_kid`, `alg_mismatch`, `bad_signature`, `timestamps_invalid`, `expired`, `lifetime_exceeded`, `user_id_missing` | `403 issuer_token_rejected` (unchanged message: "Issuer token was rejected") | Get a fresh issuer token, retry once, then fail |
| Claim not propagated yet | `claims_missing` | `403 issuer_claims_missing`, message: "Issuer token is valid, but a required entitlement claim is not present yet" | Do **not** re-auth; wait and retry (entitlement is still syncing) |
| Gateway cannot verify | `jwks_unreachable`, `jwks_invalid` | `503 issuer_verification_unavailable`, message: "Issuer keys are temporarily unavailable" | Retry with backoff; not the caller's fault |

Required mechanics:

- Extend `GatewayError` (`src/core/errors.ts`) with an optional readonly `reason?: string` (keep all existing call sites compiling — add it after `headers` or via an options bag; do not serialize `reason` in `errorResponse` for `issuer_token_rejected`; for the two new codes serializing it is unnecessary — the code itself is the signal).
- Add `issuer_claims_missing` and `issuer_verification_unavailable` to the `ErrorCode` union.
- **Reorder user-id extraction before the required-claims check.** By that point the signature is verified, so the user id is trustworthy. This lets the `claims_missing` rejection carry the verified `userId` (needed for event recording and Phase 3). Attach it to the thrown error (e.g. a `context?: { userId?: string }` on `GatewayError`, or throw a subclass) — implementer's choice, but the auth route must be able to read it from the caught error.
- `options.skipRequiredClaims` callers are unaffected (`claims_missing` can't occur there).
- The generic `catch` at the bottom (non-GatewayError from `jose` → `reject()`) should carry reason `bad_signature` (that is the dominant real cause of `jwtVerify` throwing).

#### 3.2 `src/index.ts` — log every GatewayError

In `app.onError`, before returning the `GatewayError` response, emit one structured line:

- level: `warn` for status < 500, `error` for status ≥ 500;
- message: `"gateway_error"`;
- fields: `code`, `reason` (if set), `status`, `path`, `method`, `app` (from `c.req.param("app")` when the route has it, else omit), `appVersion` (from the `X-App-Version` request header, if present).

Do not log request bodies, tokens, or headers other than `X-App-Version`. Response shape to the client is unchanged. Keep the existing `unhandled_error` path as is.

Tests: unit tests for each issuer rejection reason → expected code/status/reason; a test that `onError` logs `gateway_error` with the right fields for a GatewayError and still logs `unhandled_error` for unexpected exceptions.

### Phase 2 — `app_auth_event` table + recording

#### Schema (`src/db/schema.ts` + `pnpm db:generate` → migration `0019_*`)

New table `app_auth_event`, deliberately mirroring `app_usage_event` conventions:

| column | type | notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `event_id` | text, nullable, unique index | idempotent retry identity, same semantics as usage |
| `app_id` | text NOT NULL | no FK (history survives app deletion, same rationale as usage) |
| `user_id` | text, **nullable** | null when the token never yielded a trusted user id |
| `event` | text NOT NULL | `token_exchange` \| `register` (unconstrained text — no CHECK, growable) |
| `auth_method` | text, nullable | `attest` \| `api_key` |
| `outcome` | text NOT NULL | `ok` or the error code (`issuer_claims_missing`, `issuer_token_rejected`, `attest_failed`, `auth_required`, `issuer_verification_unavailable`, …) |
| `reason` | text, nullable | the granular reason from §3.1 |
| `app_version` | text, nullable | from `X-App-Version` header |
| `latency_ms` | integer, nullable | handler wall time |
| `claim_delay_ms` | integer, nullable | Phase 3: set on the successful exchange that ends a claim-pending window |
| `created_at` | text NOT NULL default `datetime('now')` | |

Indexes: `(app_id, created_at)`, `(app_id, user_id, created_at)`, unique on `event_id`.

#### Recording (`src/core/auth-events.ts`, new)

`recordAuthEvent(input)` modeled on `recordUsageEvent` in `src/core/usage.ts`: generate `event_id` once, insert inside `executionCtx.waitUntil` with the same retry approach; a recording failure is logged (`auth_event_record_failed`) and never thrown into the request path.

#### Wiring (`src/routes/auth.ts`)

Record one event per request to `POST /:app/auth/token` (both branches) and `POST /:app/auth/register` — successes **and** failures. Simplest structure: wrap each handler body in try/catch; on success record `outcome: "ok"`; on `GatewayError` record its `code` + `reason` + (for `issuer_claims_missing`) the `userId` carried on the error, then rethrow. Measure `latency_ms` from handler entry. Do not record `/challenge` (pure nonce issuance, no diagnostic value).

Volume note (why granular rows are fine): gateway tokens live 3600s, so exchanges are ~1/user/hour; failures during an incident are client-retry-bounded.

#### Retention

Add a cron trigger (`triggers.crons` in `wrangler.jsonc`, e.g. daily) and a `scheduled` export in `src/index.ts` that deletes `app_auth_event` rows older than 90 days. **Touch only `app_auth_event`** — usage rows are billing history and are never pruned. Configure the trigger for each deployed env in `wrangler.jsonc` as that file's env structure requires.

Tests: recording on success and each failure class; idempotent replay does not duplicate; pruning deletes only old auth events.

### Phase 3 — Claim-propagation delay metric

- Add nullable text column `claim_pending_since` to `app_user` (same migration wave or `0020_*`).
- On an `issuer_claims_missing` rejection in `/token` or `/register` (verified `userId` is available, §3.1): upsert the `app_user` row, setting `claim_pending_since = datetime('now')` **only if currently NULL** — the metric is "time since *first* rejection". Insert the row if it doesn't exist (mirror `storeIssuerUser`'s upsert, but do not touch `last_seen_at` semantics for blocked users).
- On a **successful** exchange for a user whose `claim_pending_since` is set: compute `delay_ms = now − claim_pending_since`, write it into that success's auth event (`claim_delay_ms`), emit `log("info", "claim_propagation_recovered", { app, userId, delayMs })`, and clear the column. One extra read of `app_user` per successful exchange is acceptable at this volume (the attest branch already reads the row — reuse that read where possible).
- Users stuck mid-activation are then simply `SELECT ... FROM app_user WHERE claim_pending_since IS NOT NULL`.

Tests: first rejection sets the timestamp; second rejection does not overwrite it; success computes delay, records it, clears the column; success with no pending window records no delay.

### Phase 4 — Console "Auth & Errors" view

**API** (`src/routes/console.ts`, follow the existing per-app usage endpoint's auth/authz pattern — org-scoped, same session/permission checks):

`GET .../apps/:appId/auth-events/summary?days=N` returning, for the window:

- daily counts grouped by `outcome` + `reason` from `app_auth_event`;
- daily counts of `app_usage_event` rows with `status != 'ok'` grouped by `status` (so proxy-path failures appear in the same view);
- token-exchange success rate (`ok` / total for `event = 'token_exchange'`);
- claim-delay stats over non-null `claim_delay_ms`: count, avg, p50, p95 (compute percentiles in SQL by ordered offset, or in JS over the window's values — volume is small);
- count of currently pending users (`app_user.claim_pending_since IS NOT NULL` for the app).

Optionally a second endpoint listing recent raw auth events (paged) for drill-down.

**UI** (`console/src/pages/tabs/`): new `auth-events.tsx` tab ("Auth & Errors") next to `usage.tsx`, registered wherever the app-detail tab list lives (`app-detail.tsx`). Copy `usage.tsx` structure and its test (`usage.test.tsx`): summary cards (success rate, claim-delay p50/p95, pending activations), a by-day error table/chart grouped by outcome/reason, and a recent-events list if the drill-down endpoint is built. Follow existing console component/library conventions; add a matching `auth-events.test.tsx`.

Update `scripts/generate-openapi.ts` inputs for the new endpoint(s) and codes; run `pnpm openapi:generate`.

### Phase 5 — Swift client package (`ai-gateway-swift/`, this repo)

In `Sources/AIGateway/GatewayError.swift` add:

```swift
case issuerClaimsMissing = "issuer_claims_missing"
case issuerVerificationUnavailable = "issuer_verification_unavailable"
```

In `Sources/AIGateway/AIGatewayClient.swift` (the retry at line ~204), split behavior:

- `.issuerClaimsMissing` → current behavior: invoke `issuerRejectionRecovery?()`, then retry once with a force-refreshed issuer token. This is the entitlement-sync case the recovery closure exists for.
- `.issuerTokenRejected` → retry once with a force-refreshed issuer token but **without** invoking `issuerRejectionRecovery` (a genuinely invalid token shouldn't trigger the app's purchase-sync/activation machinery).
- `.issuerVerificationUnavailable` → no recovery, no forced refresh; surface as a retryable error to the caller.

Update package tests accordingly. App-side adoption is specified in `calories-tracker-app/PLAN-adopt-gateway-auth-codes.md`.

---

## 4. Acceptance criteria

1. Every `GatewayError` response produces exactly one structured `gateway_error` log line with code/reason/status/path/app/appVersion; 5xx log at `error`, 4xx at `warn`.
2. `verifyIssuerToken` rejections carry the documented reason; `claims_missing` → `403 issuer_claims_missing` with verified `userId` attached; JWKS failures → `503 issuer_verification_unavailable`; everything else remains `403 issuer_token_rejected`.
3. Every `/token` and `/register` request (success or failure) yields one `app_auth_event` row with correct outcome/reason/latency; recording failures never fail the request.
4. Claim-propagation delay is measured per §Phase 3 and visible both in logs (`claim_propagation_recovered`) and in `app_auth_event.claim_delay_ms`.
5. Auth events older than 90 days are pruned by the scheduled job; usage events are untouched.
6. Console app detail has an "Auth & Errors" tab backed by the new endpoint, with tests, visible to the app's organization only.
7. `pnpm check` passes (typecheck, openapi:check, vitest, console tests, docs build); new migrations apply cleanly via `test/apply-migrations.ts` and `pnpm db:migrate:local`.

## 5. Rollout order

1. Merge + deploy the gateway (migrations apply during `deploy:production`).
2. Then release the iOS app update built against the updated `ai-gateway-swift` (companion plan). The gateway must go first so the new codes are live before any client expects them. Old installed builds keep working: unrecognized codes decode to `.unknown` and display the server message — that is the accepted trade-off.
