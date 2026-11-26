# The relay's wire rules for our SDK

Notes for clients that ask for the relay's own messages: our SDK, and any client
that follows these rules. The full wire protocol document comes with the
session SDK (plan step 9f). The relay's code is the reference:
`src/frames.js` and `src/index.js`.

## Asking for the relay's messages

Open the session's WebSocket with the header `x-agw-relay-messages: 1`, next to
the ticket in `authorization`. Without it, the relay sends nothing of its own
and reads none of the client's frames as relay messages: an official provider
SDK sees only the provider's frames.

## Messages

- From the relay: `{"type":"agw.session.started","reconnect_secret":…,"deadline":…}`
  once the session started, before any provider frame; and
  `{"type":"agw.heartbeat"}` in answer to the client's heartbeat.
- From the client: `{"type":"agw.heartbeat"}` after 30 s without other frames,
  and `{"type":"agw.received","bytes":N}` reports. Each starts exactly with
  `{"type":"agw.`, with no space and `type` as the first key. The relay drops
  every text frame that starts this way, even an unknown type, and forwards
  anything else to the provider, so a relay message written another way reaches
  the provider.

## Received-byte reports

- **What counts:** only the provider's frames. Text counts as its length in
  UTF-16 code units (what JavaScript's `length` gives; in Swift,
  `String.utf16.count`). Binary counts as its bytes. The relay's own messages
  don't count.
- **When:** every few seconds while provider frames arrive, and again whenever
  they stop, so nothing received stays unreported for more than a few seconds.
  Otherwise a normal pause between turns leaves the unreported tail more than
  10 s old, and the session ends as `client_too_slow`.
- **The value:** the total received since the session started: a whole number,
  never more than the relay sent. A report outside that is ignored.
- **What the relay does with them:** a client that falls about 10 s behind what
  the relay sent is ended with close code `4000` and reason `client_too_slow`.
  Tracking starts with the first provider frame, so a client that never reports
  is caught too. The relay checks when a report arrives and on its 30 s tick, so
  the end can come up to about 30 s after the 10 s mark. The number is
  provisional: it is set on a phone (plan step 9c).

## Other ends a client sees

- `4000 heartbeat_timeout`: nothing came from the client for 90 s. The relay
  checks on its 30 s tick, so this comes 90 to 120 s after the last frame.
- `1009 frame_too_large`: a client frame over 256 KB.
- `1008 rate_limited`: more than 2,000 client frames in 10 s. Heartbeats and
  reports count too.
- `1008` with an adapter's code: an adapter refused a client frame.
- `1000` with the end's reason (for example `time_cap`, `client_closed`,
  `provider_closed`, `budget_stop`, `allowance_used_up`): the session ended
  normally.
- `1000 replaced`: a newer session of the same user took this one's place (a
  takeover, or the oldest session past the user's limit). A normal close, so
  an official SDK does not reconnect on its own; the newer session goes on.
- `1011 internal_error`: the relay failed.
- `4000` with a start's code (for example `ticket_expired`, `start_queue_full`):
  the session never started.

## The session's life

A session is `starting`, then `active`, then `ended`, and never reopens. Frames
pass only while it is `active`. Its time cap counts from the ticket's start.

When a session ends for any reason but the provider hanging up, the client is
told at once. If the provider is in the middle of an answer, the relay waits for
that answer to finish, up to 10 s, so its usage is counted; nothing more reaches
the client meanwhile. Then the provider's side is hung up.

## Reconnecting

There are two kinds, kept apart (plan 5.1):

- **A new session.** The app asks the gateway for a new session, naming the old
  one in `takes_over`. The new session takes the old one's place once it is
  connected; the old one, if it is still running, ends with `1000 replaced`.
  An app that names nothing gets the same at the user's limit: the oldest
  session is replaced. This is what works today.
- **The same session again**, with the reconnect secret from
  `agw.session.started`, while the relay still holds the provider's side. This
  comes in a later step. Until then, a client that loses its link starts a new
  session.
