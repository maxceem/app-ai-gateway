# CLI and account ownership

Decisions here are the ones the code cannot state for itself. Everything with a
number in it — caps, windows, rate limits — lives in the constants and D1
triggers and is not repeated here.

## Deployment identity

`DEPLOYMENT_ID` is an immutable public UUID. The CLI compares it against the
Cloudflare Worker it is about to adopt, which is what makes a custom-domain move
or an update safe: the URL may change, the identity may not. Set
`CLI_CONSOLE_ORIGIN` only when browser handoffs are served from a second
first-party host bound to this same Worker. That host serves both halves of a
handoff — the console bundle that renders the approval screen and the
`/v1/cli/browser/` endpoints it calls — because the endpoints refuse any request
whose URL origin or `Origin` header is not exactly it.

## Who owns a fresh deployment

An empty self-host belongs to whoever takes it first, by console registration or
by CLI bootstrap. Bootstrap once required a separate installer secret; that
guarded only one of those two doors while registration left the other open, so
it bought consistency of configuration rather than security, and was removed.
What actually closes the window is that registration checks for an existing
human and account inside the statement that inserts its human, while bootstrap
checks for both inside the transaction that creates its account. Registration's
human insert therefore closes bootstrap's guard even before registration has
finished provisioning the account. Exactly one caller wins, and additional
registrations reopen only through the explicit self-host setting. Guidance to
initialize promptly, and to reset the database if a stranger gets there first,
lives in the self-hosting guides.

Cloud bootstrap is public and rate limited per IP, and each call yields its own
account.

## Operations, tokens and credential delivery

Everything the CLI asks of a deployment that must survive a lost response is
one operation: the bootstrap, an account claim, and each resource write it
sends — an app, an app key, a provider, a provider gateway, and their key
rotations. Each is one `mgmt_operation` row. The CLI generates one random token
and writes it to its local state *before* the request; the row's id is `op:`
and the token's digest, so holding the token is the whole proof. A retry with
the same token must carry the same request from the same user in the same
account, and is answered with the same operation rather than a second one —
rerun if its write never landed, reported if it did. That binding is judged on
the row as stored, so of two requests racing on one token only the one whose
row landed runs.

An operation with no browser step is kept for ninety days, and the CLI will
not resend a record older than that: a token whose row is gone would be taken
for a new one and repeat work that already landed. A browser step that expires
unapproved is dropped on both sides, and the next identical command starts a
new one. A bootstrap is recovered only by sending it again, never by polling,
because sending is also what activates the key it delivers.

An operation runs at once or owes a browser step. A resource write is run
under its row as the transaction boundary: the write lands only while the row
is pending, and the row completes in the same batch only if the write changed
exactly one row. A browser step's write also rechecks, inside that
transaction, the credential that opened it and the account's access. The
browser's proof is derived from the token, and only its digest is stored.

What an operation achieved is kept in `outcome_json` with any one-time secret
removed — a new app key, the bootstrap's management key — and the whole of it
is sealed with the vault under the operation's id for fifteen minutes, so a
CLI whose response was lost can still collect a key it has not stored yet.
Past that window, or once the key has been revoked, it is not handed over
again, and a new one is created on purpose. The CLI collects a key only through
the command that reserved its output file; polling such an operation is
refused, so a key never reaches standard output.

The bootstrap has an endpoint of its own only because it is the one kind that
needs no credential. Its row stays `completed` while the account is unclaimed,
becomes `retired` when a claim ends its authority, and `expired` once cleanup
collected the account. The expired row keeps nothing but the id: it is what
stops the same token from recreating an account the deadline already removed.

Management credentials are issued **disabled** and are enabled only when the
bootstrap row that names them has committed, because the alternative — issue,
then persist — can leave a live key that nobody received if the write fails.
Concurrent issuance keeps one winner and retires only the key it issued itself,
never the winner's. Issuing, activating and retiring those keys are cf-auth
operations; activation is repeated on each request from whichever key the
committed row names, so a run that died between the two heals on the next call
without ever resurrecting what a claim retired.

## Claim

Claim requires the browser proof from the approval URL, an interactive human
session, account review and explicit consent. Browser submission proofs travel
in the URL fragment, are removed from history on arrival and are held only in
operation-scoped `sessionStorage`, so the proof reaches the page without ever
entering a server log or the browser's history. This proves possession of the
link and of the session — it asserts nothing about mailbox ownership.

The page itself is a console route, `/cli/approve/:id`, served from the console
bundle like every other screen; this package renders no HTML. That is why the
URL handed to the CLI names it, and why Google consent for a claim returns to it
rather than to an endpoint — the fragment does not survive that redirect, which
is exactly what the `sessionStorage` copy is for. Claim registration keeps its
own endpoint rather than using the console's public sign-up, because a
deployment that refuses public registration must still be able to admit the one
human who is claiming it.

Claim attaches a human owner to the existing account and clears its expiry. It
never converts the service identity into a human one, and it never moves the
account to a different ID: the account ID is the vault encryption context and
the billing tenant, so moving it would strand encrypted provider credentials and
reset quota state. The CLI that asked for the claim keeps its access: the person
approving is at their terminal mid-command, and an approval that logged them out
of it would cost more than it protects. Ending that access is an ordinary key
revocation in the console afterwards, not a decision taken under time pressure
on the approval page.

A claim may only be approved by a person who belongs to no account other than
the one being claimed. The test is memberships rather than the session, for
three reasons: Google consent can sign the browser in as a person who already
exists, someone who registered here for a claim that then expired holds a
sign-in attached to nothing and must still be able to finish, and the account
being claimed is excluded from the count so a claim that already landed stays
re-approvable.

One field carries that decision to the browser. The details endpoint answers
with the same verdict the submission endpoint would reach — register first,
sign out first, or nothing in the way — so the approval page never offers a
button that would be refused, and never has to ask what kind of operation it is
showing. The two verdicts name remedies rather than causes because they are the
whole of what the page is told, and neither of them is signing in: arriving
with a sign-in that already has an account is exactly what a claim refuses, so
a page that offered that door would reopen the one this rule exists to shut.
Signing in is reachable on that page from one place only, the refusal of a
registration whose email is already taken, which is the lapsed-claim case above
and nothing else.

That page asks for nothing but the approval itself. It names the account and the
signed-in human side by side — the two identities a person has to tell apart
before approving — and the button is the consent; a checkbox in front of it
would only ask the same question twice.

All of that is one cf-auth transaction, guarded by its own re-read of the
approving session and of the CLI credential that asked. It runs *before* the
operation is completed, because the two halves are not equally recoverable: a claim
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

Account export is not implemented.
