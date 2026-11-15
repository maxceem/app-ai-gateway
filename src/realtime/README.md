# Realtime release boundary

Sessions run one of two ways, chosen by the `REALTIME_RELEASES` variable. By
default the gateway serves them itself: its own `RealtimeSession` Durable
Object holds the sockets, calling the gateway in-process, and a deploy ends the
sessions open at that moment. With `seamless`, each release gets a realtime
Worker of its own, described below, which deploys leave running. The session
engine is the same in both; only the Worker that hosts it differs.

## Two halves

The realtime Worker is `src/realtime/relay/`. It holds the two sockets, the
app's and the provider's, enforces the frame rules, and keeps the journal
that makes usage survive a restart. It runs no gateway code: no pricing, no
limits, no app settings, no provider routing. `test/realtime-relay.node.mjs`
builds its bundle and fails if anything from outside that folder gets in.
`import type` is fine, since it leaves no code behind.

Everything else is the gateway's, in the rest of `src/realtime/`, and the
realtime Worker asks for it through the calls in `relay/contract.ts`:

- `grant` authenticates the session again and decides what it may do: the
  provider socket to open, with its credential, the model, the output limit
  and the session limits. Each check returns a new grant, so a policy change
  takes effect at the next one. The grant holds a credential, so the realtime
  Worker keeps it in memory only.
- `admit` checks the session again and admits one response, counting it. It
  hands the realtime Worker a usage ticket to store with the claim: the usage
  record's metadata and the price the response was admitted at.
- `settle` takes the ticket back with the provider's own usage object. The
  gateway reads the usage and prices it (`usage.ts`), so a change in how usage
  is read or priced is a gateway release.
- `maintain`, `capacity` and `receipt` keep an open session in check.

So a gateway release or a price update leaves the realtime Worker's code as
it was. Release tooling names each realtime Worker after a fingerprint of its
bundle, so an unchanged bundle reuses the running Worker and its sessions stay
open. Only a change under `relay/` makes a new one.

`gateway-backend.ts` answers these calls once, for both ways sessions run.
The binding entrypoint `RealtimeBackend` (`rpc.ts`) forwards to it for a
realtime Worker, and the gateway's own `RealtimeSession` calls it in-process,
through the same contract. A refusal crosses as data either way, and an
outage as a bare error that keeps only its retry flags.

A retained realtime Worker can be a few days older than the gateway it calls,
so evolve the contract by adding optional fields, and keep reading tickets an
earlier release wrote (they carry a version, `v`). After a gateway rollback it
is the other way round: a newer realtime Worker with open sessions calls an
older gateway. So the realtime Worker must also work when a field or call it
knows is missing from the gateway's answer. The gateway answers the versions in
`SUPPORTED_CONTRACTS`; today that is one, and release tooling refuses a
retained release that declares another (see below).

Generation admission first writes a metadata-only journal entry. Main computes
its quota claim, calls an awaited RPC acknowledgement that durably records the
exact claim in the realtime object, then admits it in the original `OrgQuota`.
Provider dispatch waits for the returned admission result. Ambiguous replies
recover through receipts without dispatching again. RPC callback capabilities
are request-scoped and never persisted. Safe read/idempotent operations retry
only explicitly transient errors; policy failures and admission do not retry.

`scripts/seamless.ts` is shared by checkout/button and CLI adapters, in both
modes. It takes a bounded D1 deployment lease, applies compatible migrations,
deploys main at 100%, verifies its unique build ID and readiness, and records
the deployment. With seamless releases it creates or verifies the immutable
realtime artifact and atomically promotes discovery's pointer; without them it
promotes no release Worker, which retires one an earlier seamless release
left, so switching modes either way is an ordinary deploy.
Retirement uses the shared maximum session duration, admission grace, recovery
horizon and margin. Cleanup failures after promotion leave a successful deploy
with cleanup pending; explicit cleanup failures remain errors.

Retained runtimes require backward-compatible backend, schema and Durable
Object lifecycle changes. `REALTIME_BACKEND_CONTRACT` is effectively frozen:
a deploy refuses while any retained release declares another contract, and the
active release always declares the current one, so evolve the backend
additively instead of bumping it. Compatibility declarations are human-reviewed;
there is no SQL safety inference or database rollback. Rollback coordinates a
recorded compatible main version and realtime pointer. Release tooling must not
modify retained realtime Workers.

Tests exercise real workerd RPC callbacks, metered acknowledgement ordering,
receipt recovery, release promotion/retirement SQL and both adapters. The HTTP
stream harness promotes the D1 realtime pointer twice while a stream settles;
it does not deploy a main Worker on Cloudflare during that stream. Actual
platform deployment and network failures remain outside that harness.
