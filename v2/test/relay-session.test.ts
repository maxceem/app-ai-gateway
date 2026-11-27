/**
 * A valid ticket through the relay's real session object, in the Workers
 * test runtime (`vitest.config.ts` hosts the relay Worker with the vault's
 * `RelayKeys`, a stand-in for the gateway's contract, and a provider
 * stand-in that sends one event at once and echoes every frame): the object
 * starts the session, hands our SDK its reconnect secret, and forwards frames
 * both ways. Its id comes from the ticket (`idFromName`), and nothing in the
 * object depends on reading its own name back.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_PATH } from "../relay/src/constants.js";
import { MAX_CLIENT_FRAME, RELAY_MESSAGES_HEADER } from "../relay/src/frames.js";
import { issueTicket } from "../src/relay/tickets.ts";
import { sealForTest, splitKeysOn, testShare } from "./split-keys.ts";
import { ACCOUNT_ID } from "./helpers.ts";

const relay = () => (env as unknown as { RELAY_TEST: Fetcher }).RELAY_TEST;
const provider = () => (env as unknown as { PROVIDER_STUB: Fetcher }).PROVIDER_STUB;
/** What the stand-in for the gateway's contract got from the relay for one session. */
type Seen = { checkpoints: { slice: { measures: Record<string, number> } | null; connected: boolean }[]; closes: { endReason: string; providerCallId: string | null }[] };
const seenFor = async (sessionId: string) => (await (await (env as unknown as { RELAY_MAIN_STUB: Fetcher }).RELAY_MAIN_STUB.fetch(`https://main.test/seen/${sessionId}`)).json()) as Seen;

async function ticketFor(connection: string): Promise<string> {
  return (await issued(connection)).ticket;
}

/** A ticket and its session id; `now` and `sessionId` make another ticket for the same session. */
async function issued(connection: string, now = Date.now(), sessionId?: string, observed?: { capMs: number }): Promise<{ ticket: string; sessionId: string }> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, connection, "openai", "", "", ""];
  const blob = await sealForTest("providerKey", identity, "sk-session-object");
  const share = await testShare(ACCOUNT_ID);
  const { ticket, sessionId: id } = await issueTicket(env, {
    accountId: ACCOUNT_ID,
    appId: "app_session",
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: connection,
    operation: observed === undefined ? "openai.realtime" : "openai.realtime.calls",
    model: "gpt-realtime",
    mode: observed === undefined ? "relayed" : "observed",
    slot: "conversational",
    sessionTotal: false,
    url: observed === undefined ? "https://api.openai.com/v1/realtime" : "https://api.openai.com/v1/realtime/calls",
    capMs: observed?.capMs ?? 60_000,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
  }, now, sessionId);
  return { ticket, sessionId: id };
}

/** Opens a session and collects what the client gets, until `count` messages came. */
async function open(ticket: string, headers: Record<string, string>) {
  const response = await relay().fetch(`https://relay.test${SESSION_PATH}`, { headers: { upgrade: "websocket", authorization: `Bearer ${ticket}`, ...headers } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  let waiting: { count: number; resolve: () => void } | null = null;
  let closed = "";
  /** The close code and reason the client got, once it is closed. */
  const closing = new Promise<string>((resolve) => socket.addEventListener("close", (event) => resolve(`${event.code} ${event.reason}`)));
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
    if (waiting !== null && messages.length >= waiting.count) waiting.resolve();
  });
  socket.addEventListener("close", (event) => {
    closed = `${event.code} ${event.reason}`;
    waiting?.resolve();
  });
  socket.accept();
  const received = (count: number) =>
    messages.length >= count
      ? Promise.resolve(messages)
      : new Promise<string[]>((resolve) => {
          waiting = { count, resolve: () => resolve(messages) };
        }).then((got) => {
          if (got.length < count) throw new Error(`closed ${closed} after ${JSON.stringify(got)}`);
          return got;
        });
  return { socket, messages, received, closing };
}

/** Lets the relay see a client's close, and the provider stub's delayed echo land, in the real runtime: nothing outside shows either. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)); // real-timer: another Worker's close and timer, not observable here
const reconnectWith = (secret: string) => JSON.stringify({ type: "agw.reconnect", secret });

describe(`the relay's session object (Fable F3; split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("starts a session for a valid ticket, sends our SDK its reconnect secret, and forwards frames both ways", async () => {
    const session = await open(await ticketFor("conn_session"), { [RELAY_MESSAGES_HEADER]: "1" });
    const [first, second] = await session.received(2);
    const started = JSON.parse(first!) as { type: string; reconnect_secret: string };
    expect(started.type).toBe("agw.session.started");
    expect(started.reconnect_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // The provider's first event, sent while the session started, comes after it, untouched.
    expect(JSON.parse(second!)).toEqual({ type: "session.created" });
    // The provider got the key, in its own header, from the vault's seal (Fable round 2).
    expect(await (await provider().fetch("https://provider.test/last-key-header")).json()).toEqual({ authorization: "Bearer sk-session-object" });
    // The relay answers its own heartbeat and drops a report: neither reaches the provider, which
    // would echo it. So exactly these four come back, in this order (Gemini Neon, #260 round 1).
    session.socket.send(JSON.stringify({ type: "agw.heartbeat" }));
    session.socket.send(JSON.stringify({ type: "agw.received", bytes: 0 }));
    session.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    const four = await session.received(4);
    expect(four.slice(0, 4).map((message) => (JSON.parse(message) as { type: string }).type)).toEqual([
      "agw.session.started",
      "session.created",
      "agw.heartbeat",
      "input_audio_buffer.append",
    ]);
    expect(JSON.parse(four[3]!)).toEqual({ type: "input_audio_buffer.append", audio: "AAAA" });
    session.socket.close(1000, "done");
  });

  it("an official SDK, which asks for no relay messages, gets none: frames it sent during the start reach the provider in order", async () => {
    const session = await open(await ticketFor("conn_session_sdk"), {});
    // Sent at once, while the session is still starting: held, then forwarded in order.
    session.socket.send("first");
    session.socket.send("second");
    const messages = await session.received(3);
    expect(messages.map((message) => (message.startsWith("{") ? (JSON.parse(message) as { type: string }).type : message))).toEqual(["session.created", "first", "second"]);
    // A heartbeat-looking frame from a client that did not ask is the provider's business: forwarded.
    session.socket.send(JSON.stringify({ type: "agw.heartbeat" }));
    const [, , , forwarded] = await session.received(4);
    expect(JSON.parse(forwarded!)).toEqual({ type: "agw.heartbeat" });
    session.socket.close(1000, "done");
  });

  it("forwards binary frames as bytes both ways, and refuses a binary frame over the limit (Sol, #260 round 1)", async () => {
    const response = await relay().fetch(`https://relay.test${SESSION_PATH}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${await ticketFor("conn_session_binary")}`, [RELAY_MESSAGES_HEADER]: "1" },
    });
    const socket = response.webSocket!;
    socket.binaryType = "arraybuffer";
    const got: (string | ArrayBuffer)[] = [];
    let closed = "";
    let notify: () => void = () => undefined;
    socket.addEventListener("message", (event) => {
      got.push(event.data as string | ArrayBuffer);
      notify();
    });
    socket.addEventListener("close", (event) => {
      closed = `${event.code} ${event.reason}`;
      notify();
    });
    const until = (done: () => boolean) =>
      done() ? Promise.resolve() : new Promise<void>((resolve) => (notify = () => done() && resolve()));
    socket.accept();
    // Started, then the provider's first event.
    await until(() => got.length >= 2);
    socket.send(new Uint8Array([1, 2, 3, 250]));
    await until(() => got.length >= 3);
    const echoed = got[2];
    expect(echoed).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(echoed as ArrayBuffer)]).toEqual([1, 2, 3, 250]);
    // A binary frame over the limit is counted by its bytes and ends the session.
    socket.send(new Uint8Array(MAX_CLIENT_FRAME + 1));
    await until(() => closed !== "");
    expect(closed).toBe("1009 frame_too_large");
  });
});

describe("our SDK reconnecting to the same session (step 9a part 3)", () => {
  const relayMessages = { [RELAY_MESSAGES_HEADER]: "1" };

  it("comes back after its link drops: it gets the provider's frames from the gap first, then the session goes on", async () => {
    const ticket = await ticketFor("conn_reconnect");
    const first = await open(ticket, relayMessages);
    const [startedText] = await first.received(2);
    const started = JSON.parse(startedText!) as { reconnect_secret: string; deadline: number };
    // The provider answers this one after 300 ms: while no client is attached.
    first.socket.send("later:gap");
    first.socket.close(4001, "link lost");
    await pause(600);
    const second = await open(ticket, relayMessages);
    second.socket.send(reconnectWith(started.reconnect_secret));
    // Sent at once, while the secret is checked: it goes on in order.
    second.socket.send("after");
    const got = await second.received(3);
    // Same session, same deadline.
    expect(JSON.parse(got[0]!)).toEqual({ type: "agw.session.resumed", deadline: started.deadline });
    expect(got.slice(1)).toEqual(["later:gap", "after"]);
    // The relay's own messages work on the new link.
    second.socket.send(JSON.stringify({ type: "agw.heartbeat" }));
    expect(JSON.parse((await second.received(4))[3]!)).toEqual({ type: "agw.heartbeat" });
    second.socket.close(1000, "done");
  });

  it("a wrong secret gets the refusal any second connection gets, and the session waits on for the right one", async () => {
    const ticket = await ticketFor("conn_reconnect_wrong");
    const first = await open(ticket, relayMessages);
    const started = JSON.parse((await first.received(2))[0]!) as { reconnect_secret: string };
    first.socket.close(4001, "link lost");
    await pause(100);
    for (const wrong of [reconnectWith("not-the-secret"), "hello", JSON.stringify({ type: "agw.heartbeat" })]) {
      const intruder = await open(ticket, relayMessages);
      intruder.socket.send(wrong);
      expect(await intruder.closing).toBe("4000 session_active");
    }
    const back = await open(ticket, relayMessages);
    back.socket.send(reconnectWith(started.reconnect_secret));
    expect(JSON.parse((await back.received(1))[0]!)).toMatchObject({ type: "agw.session.resumed" });
    back.socket.close(1000, "done");
  });

  it("two clients coming back with the secret: the later one takes the session, the earlier one is let go", async () => {
    const ticket = await ticketFor("conn_reconnect_twice");
    // The first link still looks open: a phone that moved from Wi-Fi to mobile data.
    const first = await open(ticket, relayMessages);
    const started = JSON.parse((await first.received(2))[0]!) as { reconnect_secret: string };
    // Both come back at once: each sends its secret before either is answered.
    const [second, third] = await Promise.all([open(ticket, relayMessages), open(ticket, relayMessages)]);
    second.socket.send(reconnectWith(started.reconnect_secret));
    third.socket.send(reconnectWith(started.reconnect_secret));
    await Promise.all([second.received(1), third.received(1)]);
    expect(await first.closing).toBe("1000 reconnected");
    // Each took the session in turn: the one that went first was let go, the other has it.
    const [winner, loser] = await Promise.race([
      second.closing.then(() => [third, second] as const),
      third.closing.then(() => [second, third] as const),
    ]);
    expect(await loser.closing).toBe("1000 reconnected");
    // Only the session's client gets its frames.
    winner.socket.send("only-winner");
    expect((await winner.received(2))[1]).toBe("only-winner");
    expect(loser.messages).toHaveLength(1);
    winner.socket.close(1000, "done");
  });

  it("a normal close ends the session: coming back with the secret then finds it ended", async () => {
    const ticket = await ticketFor("conn_reconnect_closed");
    const first = await open(ticket, relayMessages);
    const started = JSON.parse((await first.received(2))[0]!) as { reconnect_secret: string };
    first.socket.close(1000, "done");
    await pause(200);
    const late = await open(ticket, relayMessages);
    late.socket.send(reconnectWith(started.reconnect_secret));
    expect(await late.closing).toBe("4000 session_ended");
  });

  it("reads the secret only from a small message written the relay's way, and a repeat on a live link never reaches the provider (Sol round 1)", async () => {
    const ticket = await ticketFor("conn_reconnect_form");
    const first = await open(ticket, relayMessages);
    const started = JSON.parse((await first.received(2))[0]!) as { reconnect_secret: string };
    first.socket.close(4001, "link lost");
    await pause(100);
    const secret = started.reconnect_secret;
    for (const refused of [
      // Too large to read, with the right secret inside.
      JSON.stringify({ type: "agw.reconnect", secret, pad: "x".repeat(600) }),
      // Not the relay's own form: a live session would forward these.
      JSON.stringify({ secret, type: "agw.reconnect" }),
      `{ "type": "agw.reconnect", "secret": "${secret}" }`,
    ]) {
      const attempt = await open(ticket, relayMessages);
      attempt.socket.send(refused);
      expect(await attempt.closing).toBe("4000 session_active");
    }
    const back = await open(ticket, relayMessages);
    back.socket.send(reconnectWith(secret));
    // A retry of the same message once back is the relay's: dropped, never echoed by the provider.
    back.socket.send(reconnectWith(secret));
    back.socket.send("after");
    const got = await back.received(2);
    expect(JSON.parse(got[0]!)).toMatchObject({ type: "agw.session.resumed" });
    expect(got[1]).toBe("after");
    back.socket.close(1000, "done");
  });

  it("comes back with a ticket that has expired since: it only finds the session", async () => {
    const { ticket, sessionId } = await issued("conn_reconnect_expired");
    const first = await open(ticket, relayMessages);
    const started = JSON.parse((await first.received(2))[0]!) as { reconnect_secret: string; deadline: number };
    first.socket.close(4001, "link lost");
    await pause(100);
    // The same session's ticket, signed as if two minutes ago: long expired.
    const { ticket: expired } = await issued("conn_reconnect_expired", Date.now() - 120_000, sessionId);
    const back = await open(expired, relayMessages);
    back.socket.send(reconnectWith(started.reconnect_secret));
    expect(JSON.parse((await back.received(1))[0]!)).toEqual({ type: "agw.session.resumed", deadline: started.deadline });
    back.socket.close(1000, "done");
  });

});

/** Sends an observed session's offer to the relay, as an app does: a POST, no WebSocket. */
const offer = (ticket: string, body: string) =>
  relay().fetch(`https://relay.test${SESSION_PATH}`, { method: "POST", headers: { authorization: `Bearer ${ticket}`, "content-type": "application/sdp" }, body });

/** Waits for the relay to close the session at the gateway's stand-in, and answers what it got. */
async function closed(sessionId: string): Promise<Seen> {
  for (let tries = 0; tries < 100; tries += 1) {
    const seen = await seenFor(sessionId);
    if (seen.closes.length > 0) return seen;
    await pause(50);
  }
  throw new Error("the session never closed");
}

/** The input tokens the relay booked for a session, over all its slices. */
const inputTokens = (seen: Seen) => seen.checkpoints.reduce((sum, checkpoint) => sum + (checkpoint.slice?.measures.input_tokens ?? 0), 0);

describe(`an observed session through the relay's session object (step 9a part 3; split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("starts from the app's offer with no WebSocket: the answer comes back, the side channel's usage is booked, and at its cap the call is hung up", async () => {
    const { ticket, sessionId } = await issued("conn_observed", Date.now(), undefined, { capMs: 1_500 });
    // The mock call reports an answer every 0.4 s and runs on: only the relay's cap ends it.
    const response = await offer(ticket, "v=0\r\na=x-mock-turns:0.4\r\n");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(await response.text()).toMatch(/^v=0/u);
    const seen = await closed(sessionId);
    expect(seen.closes).toEqual([expect.objectContaining({ endReason: "time_cap", providerCallId: expect.stringMatching(/^rtc_mock_/u) })]);
    const callId = seen.closes[0]!.providerCallId;
    for (let tries = 0; tries < 40 && !((await (await provider().fetch("https://provider.test/hangups")).json()) as string[]).includes(callId!); tries += 1) await pause(50);
    expect(await (await provider().fetch("https://provider.test/hangups")).json()).toContain(callId);
    // Each answer is 100 input tokens, booked once: two or three of them came before the cap.
    expect([200, 300]).toContain(inputTokens(seen));
    // The key went to the provider from the vault's seal.
    expect(await (await provider().fetch("https://provider.test/last-key-header")).json()).toEqual({ authorization: "Bearer sk-session-object" });
  });
  it("two offers at once make exactly one call, and the second is refused", async () => {
    const { ticket } = await issued("conn_observed_twice", Date.now(), undefined, { capMs: 60_000 });
    const tag = crypto.randomUUID();
    const body = `v=0\r\na=x-test:${tag}\r\na=x-mock-ends:0.5\r\n`;
    const [first, second] = await Promise.all([offer(ticket, body), offer(ticket, body)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const refused = first.status === 409 ? first : second;
    expect(["start_in_flight", "session_active"]).toContain(((await refused.json()) as { error: { code: string } }).error.code);
    expect(await (await provider().fetch(`https://provider.test/calls/${tag}`)).json()).toEqual({ made: 1 });
  });

  it("refuses an offer that is too large, and a second one after the session started", async () => {
    const { ticket } = await issued("conn_observed_big", Date.now(), undefined, { capMs: 60_000 });
    const big = await offer(ticket, `v=0\r\n${"a=x:y\r\n".repeat(20_000)}`);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: { code: "offer_too_large" } });
    expect((await offer(ticket, "v=0\r\na=x-mock-ends:0.5\r\n")).status).toBe(201);
    const again = await offer(ticket, "v=0\r\n");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "session_active" } });
  });
});

describe(`an xAI session through the relay's session object (step 9b; split keys ${splitKeysOn ? "on" : "off"})`, () => {
  /** A ticket for xAI's voice API, as the gateway issues one. */
  async function xaiTicket(connection: string): Promise<{ ticket: string; sessionId: string }> {
    const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, connection, "xai", "", "", ""];
    const blob = await sealForTest("providerKey", identity, "xai-session-object");
    const share = await testShare(ACCOUNT_ID);
    return await issueTicket(env, {
      accountId: ACCOUNT_ID,
      appId: "app_session",
      endUserId: null,
      installId: null,
      appleAccountId: null,
      appKeyId: null,
      providerType: "xai",
      connectionId: connection,
      operation: "xai.realtime",
      model: "grok-voice-3.0",
      mode: "relayed",
      slot: "conversational",
      sessionTotal: false,
      url: "https://api.x.ai/v1/realtime?model=grok-voice-3.0",
      capMs: 60_000,
      credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
      keyPlacement: { header: "authorization", format: "Bearer {key}" },
    });
  }

  it("bills from the first audio to the close, and counts the text message: the time before the first audio is free", async () => {
    const { ticket, sessionId } = await xaiTicket("conn_xai");
    const opened = Date.now();
    const session = await open(ticket, {});
    await session.received(1);
    // Nothing billable yet: a settings change is not activity.
    session.socket.send(JSON.stringify({ type: "session.update", session: { voice: "eve" } }));
    await session.received(2);
    await pause(300);
    const active = Date.now();
    session.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] } }));
    session.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    await session.received(4);
    // Some time on the clock before the close: the runtime's clock moves only between events.
    await pause(200);
    session.socket.close(1000, "done");
    const closedAt = Date.now();
    const seen = await closed(sessionId);
    const slices = seen.checkpoints.flatMap((checkpoint) => (checkpoint.slice === null ? [] : [checkpoint.slice as { measures: Record<string, number>; sessionMs: number }]));
    expect(slices.reduce((sum, slice) => sum + (slice.measures.text_messages ?? 0), 0)).toBe(1);
    const billed = slices.reduce((sum, slice) => sum + slice.sessionMs, 0);
    // Only the time from the first audio: the 300 ms before it are not billed.
    expect(billed).toBeGreaterThan(0);
    expect(billed).toBeLessThanOrEqual(closedAt - active + 200);
    expect(billed).toBeLessThan(closedAt - opened);
    expect(seen.closes).toEqual([expect.objectContaining({ endReason: "client_closed" })]);
  });
});
