# CLI and account ownership

Decisions here are the ones the code cannot state for itself. Everything with a
number in it — caps, windows, rate limits — lives in the constants and D1
triggers and is not repeated here.

## Deployment identity

`DEPLOYMENT_ID` is an immutable public UUID. The CLI compares it against the
Cloudflare Worker it is about to adopt, which is what makes a custom-domain move
or an update safe: the URL may change, the identity may not. Set
`CLI_CONSOLE_ORIGIN` only when browser handoffs are served from a second
first-party host bound to this same Worker.

## Who owns a fresh deployment

An empty self-host belongs to whoever takes it first, by console registration or
by CLI bootstrap. Bootstrap once required a separate installer secret; that
guarded only one of those two doors while registration left the other open, so
it bought consistency of configuration rather than security, and was removed.
What actually closes the window is that both paths check for an existing account
inside the statement that creates one, so exactly one caller wins and neither
door reopens afterwards. Guidance to initialize promptly, and to reset the
database if a stranger gets there first, lives in the self-hosting guides.

Cloud bootstrap is public and rate limited per IP, and each call yields its own
account.

## Proofs, receipts and credential delivery

The CLI generates an idempotency key and a poll token and writes both to its
local state *before* the request, so a response lost to a dropped connection is
recoverable. Retrying with the same pair returns the same account and the same
protected credential rather than creating a second one; a mismatched proof is
rejected outright.

Three stores are deliberately kept apart: bootstrap uses the gateway's
resource-creation receipt, claim and provider browser handoffs use
`mgmt_handoff`, and Better Auth's verification rows are left to Better Auth.
Mixing them would let one feature's cleanup or expiry policy silently govern
another's.

Management credentials are issued **disabled** and are enabled only when the
encrypted receipt commits, because the alternative — issue, then persist — can
leave a live key that nobody received if the write fails. Concurrent issuance
keeps one winner and retires only the key it issued itself, never the winner's.
The one-time response is encrypted with the vault under the poll-proof hash, so
the receipt row alone does not disclose a credential.

Issuing, activating and retiring those keys are all cf-auth operations rather
than statements written here: this package owns the receipt, and the library
owns every credential in it. That splits the two writes, so activation is
repeated on each poll from whichever key the committed receipt names — it is
idempotent and refuses a revoked key, so a run that died between the two heals
on the next call without ever resurrecting what a claim retired.

## Claim

Claim requires an interactive human session, a separate code displayed in the
terminal, account review and explicit consent. The code is never embedded in the
URL: possession of a link that someone pasted must not be enough. Browser
submission proofs travel in the URL fragment, are removed from history on
arrival and are held only in operation-scoped `sessionStorage`. This proves
possession of the session and the code — it asserts nothing about mailbox
ownership.

Claim attaches a human owner to the existing account and clears its expiry. It
never converts the service identity into a human one, and it never moves the
account to a different ID: the account ID is the vault encryption context and
the billing tenant, so moving it would strand encrypted provider credentials and
reset quota state. The person claiming decides whether the CLI keeps access;
declining revokes that service identity's keys and removes its membership while
preserving its audit history.

All of that is one cf-auth transaction, guarded by its own re-read of the
approving session and of the CLI credential that asked. It runs *before* the
handoff is consumed, because the two halves are not equally recoverable: a claim
that landed can simply be approved again, since claiming settles on the same
owner rather than refusing, while a request consumed without a claim could never
be retried.

## Deadlines, cleanup and usage

Two independent clocks apply to an unclaimed cloud account: one for how long it
may be used, and a longer one for how long it may still be claimed. Both are
read fresh on every dispatch, after application-user limits — a cached
application or billing answer must never extend either.

Scheduled cleanup deletes expired unclaimed accounts in bounded batches and
re-checks the expiry and ownership predicate for every delete, so an account
claimed while the job is running is never collected. Orphaned service identities
are removed the same way; human identities never are.

Usage rows and rollups carry the owning account ID captured at admission rather
than resolved later, so deleting an app or settling a stream late still bills
the right account, and an app ID cannot be reused by a different account while
its history exists.

The scheduled job's D1 statements are budgeted against the Free plan's
per-invocation query limit: usage retention, the authentication sweeps and
account cleanup each reserve a share, and the sum has to stay under it. Adding a
query to any one of them means re-checking the total.

## Status

The schema is maintained as a single fresh initial migration while the feature
is pre-release; there is no populated-database upgrade path. Account export is
not implemented.
