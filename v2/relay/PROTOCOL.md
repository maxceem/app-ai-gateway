# The relay's wire rules for our SDK

Notes for clients that ask for the relay's own messages: our SDK, and any client
that follows these rules. The guide for app developers is
`docs/content/docs/integrate/live-sessions.mdx`. The relay's code is the
reference: `src/frames.js` and `src/index.js`.

## Asking for the relay's messages

Open the session's WebSocket with the header `x-agw-relay-messages: 1`, next to
the ticket in `authorization`. Without it, the relay sends nothing of its own
and reads none of the client's frames as relay messages: an official provider
SDK sees only the provider's frames.

## Messages

- From the relay: `{"type":"agw.session.started","reconnect_secret":…,"deadline":…}`
  once the session started, before any provider frame;
  `{"type":"agw.session.resumed","deadline":…}` when the client came back to
  the same session (see "Reconnecting"); and `{"type":"agw.heartbeat"}` in
  answer to the client's heartbeat, at once. Our SDK takes a heartbeat with no
  answer within 10 s as a link that died without a word, and comes back on a
  new link.
- From the client: `{"type":"agw.heartbeat"}` after 30 s without other frames,
  `{"type":"agw.received","bytes":N}` reports, and
  `{"type":"agw.reconnect","secret":…}` as the first message when it comes back. Each starts exactly with
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
  30 s old, and the session ends as `client_too_slow`.
- **The value:** the total received on the current link, since
  `agw.session.started` or `agw.session.resumed`: a whole number, never more
  than the relay sent on that link. A report outside that is ignored.
- **What the relay does with them:** a client that falls about 30 s behind what
  the relay sent is ended with close code `4000` and reason `client_too_slow`.
  Tracking starts with the first provider frame, so a client that never reports
  is caught too. The relay checks when a report arrives and on its 30 s tick, so
  the end can come up to about 30 s after the 30 s mark. Set on a phone in step
  9c: xAI sends a one-minute answer within a few seconds, so a phone on a slow
  link can be well behind the relay and still ahead of playback.

## Other ends a client sees

- `4000 heartbeat_timeout`: nothing came from the client for 90 s. The relay
  checks on its 30 s tick, so this comes 90 to 120 s after the last frame.
- `1009 frame_too_large`: a client frame over 256 KB.
- `1008 rate_limited`: more than 2,000 client frames in 10 s. Heartbeats and
  reports count too.
- `1008` with an adapter's code: an adapter refused a client frame.
- `4000 adapter_unknown`: the gateway named a provider adapter this relay does
  not have yet. A new provider works once both the gateway and the relay are
  deployed.
- `1000` with the end's reason (for example `time_cap`, `client_closed`,
  `provider_closed`, `budget_stop`, `allowance_used_up`): the session ended
  normally.
- `1000 replaced`: a newer session of the same user took this one's place (a
  takeover, or the oldest session past the user's limit). A normal close, so
  an official SDK does not reconnect on its own; the newer session goes on.
- `1000 reconnected`: the same client came back on a new link with the
  reconnect secret, and this older link was let go. The session goes on there.
- `1011 internal_error`: the relay failed.
- `4000` with a start's code (for example `ticket_expired`, `start_queue_full`):
  the session never started.

## The session's life

A session is `starting`, then `active`, then `ended`, and never reopens. Frames
pass only while it is `active`. Its time cap counts from the ticket's start.

When a session ends, the client is told at once. If the provider is in the
middle of an answer, the relay waits for that answer to finish, up to 10 s, so
its usage is counted; nothing more reaches the client meanwhile. Then the
provider's side is hung up.

- There is no wait when the provider hung up, or at the time cap. The wait never
  runs past the cap.
- If the provider hangs up during the wait, the wait ends there, and so does the
  session's time.
- An answer that never finished was cut off. Its usage is missing, so the
  session's last charge is marked partial.

### xAI's voice API

An xAI session is billed as xAI bills it: by time, plus each text message. The
time is the larger of two running totals: the session's clock, from its first
activity to its close, and the audio xAI reports it bills
(`billable_audio_seconds`). With a microphone streamed in real time they agree.
A long answer to a text question can bill far more audio than the clock.

- The first activity is the first audio frame sent to xAI (an
  `input_audio_buffer.append`, a binary frame, or an item with audio content),
  or xAI's first answer (`response.created`). The time before it is free. A
  `response.create` alone starts nothing: its answer does.
- From then on, the time is billed to the close, silence too. xAI never closes
  a quiet session, so close it when the user is done.
- Each `conversation.item.create` the client sends counts as one text message,
  except a tool result (`function_call_output`), which is not billed, and an
  item with audio content, which counts as audio.
- xAI's `ping` every 10 s does not keep a session alive: a client that sends
  nothing for 90 s is gone, as for any provider.

### ElevenLabs streaming text to speech

An ElevenLabs stream (`v1/text-to-speech/{voice_id}/stream-input`) is billed as
a text-to-speech call is: by the characters of the text the client sends, at
the model's rate per character. Its connection time is not billed.

- The client's text frames are counted after they went to ElevenLabs: each
  frame's `text`, in characters as a person counts them (an emoji is one).
  Text that is only white space counts nothing: the opening `" "` and the
  closing `""`.
- The model (`model_id`) and the voice (the path) are in the address the
  session is sealed for, so no frame can change them. Everything else goes as
  it is.
- Once a frame names `pronunciation_dictionary_locators`, every later
  character is an estimate: a dictionary can change what ElevenLabs bills.
- The client's last text before it hangs up is counted: the session's end
  waits for its count to be written, as for any usage, at most 2 s.

### Deepgram streaming speech to text

A Deepgram stream (`v1/listen`) is billed by time, at Deepgram's streaming
rates with the stream's language and add-ons. The time is the larger of two
running totals, as for xAI: the session's clock from the client's first audio
frame to the close, and the audio Deepgram reports it heard (each `Results`
frame's `start` plus `duration`, and the closing `Metadata`'s `duration`, for
each channel billed).

- The client's binary frames are audio; `KeepAlive`, `Finalize` and
  `CloseStream` are not. The time before the first audio is free.
- The relay keeps the request id Deepgram sends when the stream opens
  (`dg-request-id`). After the end, the gateway reads Deepgram's record of the
  request and settles the session to Deepgram's own dollar figure, for up to an
  hour; after that, or when the key can't read it, the estimate stays.

### Gemini Live

A Gemini Live session is billed by the tokens of each turn, as Gemini reports
them, with audio, images and video at their own rates.

- **The setup.** Send Gemini's `setup` as your first message, as usual. The
  relay sets its `model` to the session's model, turns on context compression
  unless you set your own, and removes any `sessionResumption` you set: the
  relay resumes the session itself. A first message that is not a valid
  `setup` ends the session with `1008 setup_required`. A second `setup` is
  dropped.
- **Gemini's connection limits are handled for you.** Gemini closes a
  connection after a while, warning first with `goAway` on some models. The
  relay then opens a new connection to the same conversation, with the next
  resumption handle Gemini sends, at a quiet moment: no answer running, nobody
  speaking, and nothing asked since the last answer finished. Without such a
  moment it switches shortly before Gemini's own close. It also reconnects when
  Gemini closes a connection without warning. Your link stays open. You never
  get `goAway`, `sessionResumptionUpdate`, or a second `setupComplete`.
  Messages you send during the switch (usually under a second, at most a few)
  wait and then go on, in order.
- **A refused message ends the session.** If Gemini closes a connection within
  5 s of setting it up (it refused something you sent), the relay does not
  reconnect: the session ends with Gemini's close code and reason where they
  can be sent, else `1011`.
- **What can be lost.** Speech sent during a switch can lose its start on some
  models. An answer cut by a switch, or by Gemini closing the connection,
  stops: it never reports its usage, so its audio is billed from what was
  forwarded, about 25 tokens a second, marked as an estimate.
- If the relay cannot reconnect within 10 s, the session ends with
  `1000 provider_closed`; if the session's time runs out during a switch, with
  `1000 time_cap`.

### OpenAI Realtime

An OpenAI Realtime session is billed by the tokens of each answer, as OpenAI
reports them in `response.done`, with audio, images and cached input at their
own rates.

- **The model is the session's.** It is in the address the relay connects to.
  A `session.update` that names another `model` is sent on with the session's
  model instead, written again whole. Everything else you send goes to OpenAI
  as it is. The relay parses any text frame that could be a `session.update`
  (an escape or a repeated key included); a `session.update` sent as a binary
  frame is not checked. This is a known limit.
- **Input transcription is billed apart**, at the transcription model's price:
  the model OpenAI states in `session.created` or `session.updated`, and the
  usage in each `conversation.item.input_audio_transcription.completed`. A
  closing session waits for transcriptions still to come, within its closing
  wait.
- **An answer the session's own end cuts** (its time cap, a stop) reports no
  usage: its audio is billed from what was forwarded, 20 tokens a second,
  marked as an estimate, in the session's audio format. An answer you cancel
  reports its own usage.

### GPT-Live

A GPT-Live session (`v1/live/sessions`) is billed by the minute, plus each
call its backend model makes, at that model's own price.

- **Start with `session.start`**, as OpenAI asks. Its `model` is set to the
  session's. GPT-Live's events are JSON text: a binary frame ends the session
  with `1008 binary_not_supported`, and a settings frame that isn't a JSON
  object with `1008 invalid_frame`.
- **The time** runs from `session.started`, where OpenAI's own clock starts, to
  the close. It is billed at the larger of the relay's clock and OpenAI's voice
  seconds (`session.usage.updated`, `session.closed`), so never below OpenAI.
- **The backend** (`session.delegation`): none, or your app's own (`client`), or
  `responses` with a `model` your app may call through Responses and that has a
  price. Every `session.start` or `session.update` that sets `responses` must
  name that `model`, even when it only changes other backend settings. Its
  `tools` may only be function tools. Its `service_tier` is set to `default`:
  an explicit other tier ends the session with
  `1008 backend_tier_not_allowed`, since backend calls are booked at the
  standard rate. A `session.update` that sets no delegation is not checked.
- **No transcript `triggers`**: they run Decisions, which the relay can't check
  or bill. A non-empty `triggers` ends the session with
  `1008 triggers_not_allowed`.
- Any other refusal ends the session with `1008` and one of
  `backend_model_not_allowed`, `backend_tool_not_allowed` or
  `delegation_not_allowed`. The relay reads each settings frame whole, as
  OpenAI reads it, and sends it written again.
- **Each backend call** is billed apart, at its model's price, from the usage
  in its `response.completed` (or `failed`, `incomplete`). A closing session
  waits for backend calls in progress, within its closing wait; one still
  running at the cutoff marks the final slice partial.
- **A restart of the relay ends the session**: OpenAI drops it when its
  connection goes, and it can't be rejoined. The time since the relay last
  saved the session's usage is then an "unknown cost" gap: about 15 s at most
  while OpenAI's voice seconds grow, longer when nothing new came. Start a new
  session.

## Reconnecting

There are two kinds, kept apart (plan 5.1):

- **A new session.** The app asks the gateway for a new session, naming the old
  one in `takes_over`. The new session takes the old one's place once it is
  connected; the old one, if it is still running, ends with `1000 replaced`.
  An app that names nothing gets the same at the user's limit: the oldest
  session is replaced. This is what works today.
- **The same session again**, with the reconnect secret from
  `agw.session.started`, while the relay still holds the provider's side. See
  below.

### Coming back to the same session

When the client's link drops, the session goes on without it, and the
provider's side stays open:

- **What counts as a drop:** any close but a normal one. A close with `1000` or
  `1001`, or with no code (`1005`), ends the session, as before. So does any close from a client that did
  not ask for the relay's messages: an official SDK starts a new session.
- **While the link is down:** the provider's frames are held for the client, in
  order, up to 512 frames or 8 MB (text counts 1 byte per character). More
  than that, and the session ends with `client_closed`. A protocol whose rule
  is to end at once (ElevenLabs agents, later) ends the session at the drop.
- **How long:** the heartbeat still runs. If no client comes back within 90 s
  of the last frame the client sent, the session ends on the relay's next
  30 s tick (`heartbeat_timeout`), so the gap can last 90 to 120 s. The session's
  deadline does not move.

To come back, the client opens the session's WebSocket again, with the same
ticket and `x-agw-relay-messages: 1`. The ticket may have expired by then: it
only finds the session. Its first message must be, within 10 s:

```json
{"type":"agw.reconnect","secret":"<reconnect_secret>"}
```

Write it like every relay message: starting exactly with `{"type":"agw.`, and
no longer than 512 characters. Anything else is not read. The secret goes only
in this message, never in a URL or a header. The relay checks it against the
hash it stored. Then:

- **It matches:** the relay sends
  `{"type":"agw.session.resumed","deadline":…}`, then the held frames, then
  everything that follows. Frames the client sent right after the secret go to
  the provider, in order. The session is the same one: same journal, same
  slices, same deadline.
- **The old link still looks open** (a phone that moved from Wi-Fi to mobile
  data): the new one takes over anyway, and the old one is closed with
  `1000 reconnected`. The same happens if two clients come back: the later one
  wins.
- **Received-byte reports start again from zero** on the new link: count only
  what came after `agw.session.resumed`, held frames included.
- **Anything else** (a wrong secret, another first message, nothing within
  10 s) gets `4000 session_active`, the refusal any second connection gets.
  The session runs on, and the right secret can still come.
- **The session can't be taken back** (it is ending or ended, its time is
  over, or the relay restarted and lost the provider's side, also when that
  happens while the relay waits for the first message): the client gets `4000` with
  `session_ended`, or `ticket_expired` once the ended session is cleaned up.
  After a restart the session is ended right then, so its slot is free for a
  new one. Either way: don't try again, ask the gateway for a new session and
  name the old one in `takes_over`.

## Observed sessions

An observed session has no client socket (plan section 5). Media goes between
the app and the provider directly; the relay holds only the call's side
channel. Only the mock is served for now: the gateway issues observed tickets
from plan step 12, which also adds what is specific to OpenAI.

- **Starting:** the app sends its offer to the session path in a `POST`, with
  the ticket in `authorization` and the offer as the body (at most 64 KB). A
  WebSocket with an observed ticket gets `400 offer_required`. The relay
  creates the call, stores its id, and only then answers `201` with the
  provider's answer (`application/sdp`).
- **Refusals** are JSON, `{"error":{"code":…}}`, with the start's code:
  `401 ticket_refused` or `ticket_expired`; `409 session_active`,
  `start_in_flight` or `session_ended`; `413 offer_too_large`;
  `502 provider_unavailable`; `503` for anything else, such as
  `credential_unavailable` or `open_failed`.
- **The side channel:** the relay attaches it after the answer, and again at
  once whenever it closes after at least 5 s (sooner, on its next 30 s tick),
  with that tick as the backup, also after the relay restarts. An attach that gets `404` means the call ended, and the
  session ends with `provider_closed`. Any other refusal keeps the call: the
  relay tries again on each tick, and the session ends only on a `404`, a stop
  from the gateway, or the time cap. Time without the side channel is not
  counted as connection time.
- **The end:** at the cap or on a stop, the relay hangs the call up. A hang-up
  that fails is tried again on each wakeup until the session's sealed key
  expires, then given up on and logged. An attach never waits past the cap.
