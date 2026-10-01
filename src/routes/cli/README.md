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
one operation: the bootstrap, a login, an account claim, and each resource
write it sends — an app, an app key, a provider, a provider gateway, and their
key rotations.

### Who owns what

Operations are cf-auth's. Its engine owns the `mgmt_operation` table and every
state a row moves through — `pending`, then `completed` or `denied`, `expired`
when nobody answered in time, `retired` when a completed one's authority ends —
and the guards that make opening, approving, completing and amending each one
write. It also seals what an operation produced and hands it over. This gateway
registers its kinds with the engine (`src/auth/operation-kinds.ts`, loaded by
`createIdentityAuth` with the deployment id as the realm every proof and user
code is bound to), and decides everything the engine does not: what each kind
does and what a completed operation's record holds
(`src/management/operation-kinds.ts`, and for a bootstrap
`src/management/provisioning.ts`), how a resource write runs under the
engine's guard (`src/management/resource-operations.ts`, which the MCP server's
change tools run through too), and who may approve a claim or a login and what
the page is told (`identity-handoff.ts`, `browser.ts`). The routes read
operations only through the engine's views — `findByToken`, `poll` and
`details` — and never the table; the exceptions are the claim's Google grant
and its bootstrap retirement, below under Claim, and account cleanup.

The engine's own `login` kind is used as it ships. A claim is an engine browser
kind whose approval is cf-auth's `claimOrganization`; asking for one is
`openClaim` in `src/management/claims.ts`, which any transport may call. The bootstrap and a
resource write sent without a browser step are completed by the gateway,
through the engine's `complete` and under its `guard`. A resource write with a
browser step is an engine browser kind approved by its link alone
(`approver: "proof"`), with the secret its page collected as the approval's
`input`, which the engine never stores.

### Tokens and ids

The CLI generates one random token and writes it to its local state *before*
the request. The engine keeps only its digest, so holding the token is the
whole proof. The CLI knows an operation as `op:` and the token's digest, which
it computes itself, and every operation is opened with that as the engine's id,
so the two never differ.

A retry with the same token must carry the same request from the same sender in
the same account, and is answered as the engine answers a poll of the same
operation — rerun if its write never landed, reported if it did. The engine
judges that binding on the row as stored, so of two requests racing on one
token only the one whose row landed runs. A resource write's request may carry
its secret, so what the engine stores and binds is a digest of it
(`ResourceEnvelope`); a resource write with a browser step also stores what its
approver reviews and who sent it, since the write runs as its sender. The
engine knows a write that runs at once and the same write behind a browser step
as two kinds (`provider.add` and `provider.add.browser`), so a token opened as
one is never taken for the other.

Every record is kept for ninety days from when it was opened, and the CLI will
not resend a record older than that: a token whose row is gone would be taken
for a new one and repeat work that already landed. A bootstrap's is kept for a
hundred and eighty, because its account may live ninety before cleanup
collects it and the tombstone must still be there for the CLI's ninety days of
resending after that; the nightly run sweeps the engine before it collects
accounts, so a record that expired with its account would be gone before the
tombstone was written. A bootstrap also waits that long while pending: one
whose account batch failed is finished by the same token whenever it is sent
again, and never reads as the expired record an account the deadline removed
leaves. So does a resource write sent without a browser step, which has no
person to wait for and is pending only when its write failed: the same token
reruns it for as long as the CLI will send it. Such a write, and a bootstrap,
never counts toward the engine's caps on how many operations may wait at once,
per account and per sender: those caps are for steps a person has to answer —
a claim, a login, a resource write's browser step — and a failed write left
for its CLI to resend must not use up an account's room for them. On a hosted deployment, where
each token has an account of its own, a bootstrap that finds its account
already there completes on it rather than refusing. A browser step that expires
unapproved is dropped on both sides, and the next identical command starts a
new one. A bootstrap is recovered only by sending it again, never by polling,
because sending is also what activates the key it delivers.

### Running a write

An operation runs at once or owes a browser step. A resource write is the
management service's own, run as it always is — its plan caps, its sealing of a
provider secret, its refusals and the caches it clears — with its statements
built as drizzle query builders, which is what a D1 batch can carry. It runs
under the engine's guard: the write lands only while the operation is pending
and inside its deadline and the credential that sent it is still live with its
role. Where the service would commit, the engine commits instead, completing
the operation in the same batch only if the write changed a row: through
`complete` for a write that runs at once, and through `approve` for a browser
step, whose kind hands back the statements the gateway staged for it just
before. A browser step's write also rechecks the account's access inside that
transaction.

A resource write's browser step asks nothing of whoever holds the browser — the
proof in its link and the credential that opened it are its whole authority —
so it carries no user code, which on its own would be guessable. Anyone holding
a browser step's link may decline it, signed in or not; only an approved step
answers a later submission as approved, and a declined, withdrawn or expired
one says so.

### What a completed operation keeps

What a claim or a resource write achieved is its record, with any one-time
secret removed — a new app key — while the engine holds the whole of it sealed
for fifteen minutes and hands it to every answer inside that window, however
many retries race for it, so a CLI whose response was lost can still collect a
key it has not stored yet. Past the window, once the key has been revoked, or
once the CLI credential that sent the operation has been — the engine rechecks
it on every answer — it is not handed over again, and a new one is created on
purpose. The CLI collects
a key only through the command that reserved its output file; polling such an
operation is refused, so a key never reaches standard output. A login's key is
handed over once instead, since nothing retries a login's answer, and only
while it can still authenticate: a key revoked in the console before its CLI
collected it is withdrawn, the poll that would have carried it answers the login
as expired, and so does every poll after, as does a redeem.

The bootstrap's record is the account it created, the service identity that
owns it, and the one key it stands behind, whose plaintext the engine holds
sealed the same way. It stays `completed` while the account is unclaimed,
becomes `retired` when a claim ends its authority, and `expired` once cleanup
collected the account. The expired record keeps nothing but the id: it is what
stops the same token from recreating an account the deadline already removed,
for the rest of its retention. A bootstrap is opened by nobody, so it names its
account only in its record — never in the organization column, whose foreign
key would delete it with the account — and cleanup finds it there.

Management credentials are issued **disabled** and are enabled only when the
bootstrap record that names them has committed, because the alternative — issue,
then persist — can leave a live key that nobody received if the write fails.
The account is created in the same batch that completes the bootstrap, so a
bootstrap is either pending with no account or completed with one. That write,
the deployment rule that admits it and its per-address limit live in
`src/management/provisioning.ts`, shared with any other door to an unclaimed
account; what stays here is the token, the key and the answer. Its key
needs that account's membership, so it is issued next and written into the
record, sealed, by the engine's `amend` — the same guarded write that renews it
once its window has passed, and that lands only while no key is held sealed and
no person owns the account. Concurrent issuance keeps one winner and retires
only the key it issued itself, never the winner's. Activation is repeated on
each request from whichever key the committed record names, so a run that died
between the two heals on the next call without ever resurrecting what a claim
retired. Bootstrap keys say `source: "bootstrap"`.

## Login

A login is how a CLI that holds no credential gets one: it opens the engine's
`login` operation, the person who approves it on the console's approval page
picks one of their accounts, and the engine mints a management key owned by
that person, named after the CLI's label and marked `source: "cli"`, in the
batch that completes the operation. The key is handed to the CLI once — by the
first poll that finds it approved, or, when the CLI registered a loopback
listener, only through `redeemCliLogin` with the one-time code the approval page
sends there. A CLI logs out by revoking the key it holds, which any key may do
for itself.

Approving needs an interactive human session. Nobody signed in is the same
`registration_required` a claim reports, and the approval page's registration
endpoints admit a login's approver exactly as the console's own sign-up would —
unlike a claim's, they do not open a deployment whose registration is closed.
Belonging to other accounts is no obstacle; that is what a login is for. A
person who belongs to none is given an account of their own where registering
would give them one, and refused with `no_eligible_organization` where it would
not.

A login's link carries the engine's proof in its fragment, and the terminal also
prints an eight-character user code, which the approval page shows back however
it was reached so the two can be compared; a person who would rather type it finds the
step through `cliBrowserLookup`, which is counted per network address because a
code is short enough to guess in bulk. Opening a login is limited per network
address, since nobody is signed in to count it against, and twice over: the
gateway counts how many logins an address asks for an hour, because one it
declines straight away frees its place, and the engine caps how many of them
may wait at once. A resend of a login already asked for counts toward neither.
The engine is handed the address as the key to count by, never the client's
own description of itself, and a request with no edge in front of it counts as
the one `local` address rather than escaping either limit. A login's record is
kept for a day from when it was asked for rather than the ninety other
operations keep: its key is collected within minutes or not at all, and what
an address that asks and declines over and over leaves behind is gone by the
next day. The engine keeps a record for a set time from opening, whatever state
it ends in, so that day covers a pending login too. Any member may
approve a login into their account, and the key it mints carries their role.

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
human who is claiming it. Its Google grant is a signed, HttpOnly cookie on the
callback path naming the claim, issued only once the link's proof has been
checked; the callback asks only whether that claim is still pending, with one
query, before it chooses the identity instance that serves it. A login's
approver signs in or registers with Google exactly as on the console's sign-in
page, with no grant.

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

All of that is one batch: cf-auth builds the claim's statements, guarded by its
own re-read of the approving session and of the CLI credential that asked and
by the operation's guard besides, and the engine commits them in the batch that
completes the claim, riding on the last of them, which changes a row exactly
when the approver ends up owner. So a claim lands exactly when its operation
completes: a claim declined a moment before its approval committed leaves no
owner behind, and one approved first makes a later denial a refusal.

Approving a claim that already landed is answered as approved only for the
person it landed on, its owner now; anyone else is told it was taken. Should
the engine's own re-check of the claim refuse after the page's check passed,
its refusal is answered in the same codes the page's check would have used. A
refusal the page has no word for — a newer library's login verdict, say — is
shown as the need to sign in as someone who may approve, rather than breaking
the page. The claim then retires the account's bootstrap — found by the account
its record names, the one place the routes read the table, because the engine
can find an operation by its token or its id but not by what its record holds.

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
