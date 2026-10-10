# Realtime release boundary

The stable gateway keeps authentication, encrypted provider credentials, D1,
application limits and the account allowance. `RealtimeBackend` is a binding-only
Worker entrypoint exposing the small `SessionBackend` contract. HTTP inference
continues to use the same local helpers directly.

Each realtime bundle is deployed once under its content fingerprint and owns
its `RealtimeSession` Durable Objects. Discovery returns its direct WebSocket
address. The upgrade authenticates the original headers through the backend;
no ticket, bearer URL, main-worker WebSocket proxy or per-audio-frame RPC is
involved. Development on loopback can use the existing local backend.

Generation admission first writes a metadata-only journal entry. Main computes
its quota claim, calls an awaited RPC acknowledgement that durably records the
exact claim in the realtime object, then admits it in the original `OrgQuota`.
Provider dispatch waits for the returned admission result. Ambiguous replies
recover through receipts without dispatching again. RPC callback capabilities
are request-scoped and never persisted. Safe read/idempotent operations retry
only explicitly transient errors; policy failures and admission do not retry.

`scripts/seamless.ts` is shared by checkout/button and CLI adapters. It takes a
bounded D1 deployment lease, applies compatible migrations, deploys main at
100%, verifies its unique build ID and readiness, creates or verifies the
immutable realtime artifact, and atomically promotes discovery's pointer.
Retirement uses the shared maximum session duration, admission grace, recovery
horizon and margin. Cleanup failures after promotion leave a successful deploy
with cleanup pending; explicit cleanup failures remain errors.

Retained runtimes require backward-compatible backend, schema and Durable
Object lifecycle changes. Compatibility declarations are human-reviewed;
there is no SQL safety inference or database rollback. Rollback coordinates a
recorded compatible main version and realtime pointer. Release tooling must not
modify retained realtime Workers.

Tests exercise real workerd RPC callbacks, metered acknowledgement ordering,
receipt recovery, release promotion/retirement SQL and both adapters. The HTTP
stream harness promotes the D1 realtime pointer twice while a stream settles;
it does not deploy a main Worker on Cloudflare during that stream. Actual
platform deployment and network failures remain outside that harness.
