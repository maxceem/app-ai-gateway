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
  `{"type":"agw.` and is never forwarded to the provider.

## Received-byte reports

- **What counts:** only the provider's frames. Text counts as its length in
  UTF-16 code units (what JavaScript's `length` gives; in Swift,
  `String.utf16.count`). Binary counts as its bytes. The relay's own messages
  don't count.
- **When:** every few seconds while provider frames arrive, and once more after
  the provider's last frame, so the tail is counted.
- **The value:** the total received since the session started: a whole number,
  never more than the relay sent. A report outside that is ignored.
- **What the relay does with them:** a client that falls about 10 s behind what
  the relay sent is ended with close code `4000` and reason `client_too_slow`.
  Tracking starts with the first provider frame, so a client that never reports
  is caught too. The number is provisional: it is set on a phone (plan step 9c).

## Other ends a client sees

- `4000 heartbeat_timeout`: nothing came from the client for 90 s.
- `1009 frame_too_large`: a client frame over 256 KB.
- `1008 rate_limited`: more than 2,000 client frames in 10 s.
- `4000` with a start's code (for example `ticket_expired`, `start_queue_full`):
  the session never started.
