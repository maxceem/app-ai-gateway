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

async function ticketFor(connection: string): Promise<string> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, connection, "openai", "", "", ""];
  const blob = await sealForTest("providerKey", identity, "sk-session-object");
  const share = await testShare(ACCOUNT_ID);
  const { ticket } = await issueTicket(env, {
    accountId: ACCOUNT_ID,
    appId: "app_session",
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: connection,
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode: "relayed",
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    capMs: 60_000,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
  });
  return ticket;
}

/** Opens a session and collects what the client gets, until `count` messages came. */
async function open(ticket: string, headers: Record<string, string>) {
  const response = await relay().fetch(`https://relay.test${SESSION_PATH}`, { headers: { upgrade: "websocket", authorization: `Bearer ${ticket}`, ...headers } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  let waiting: { count: number; resolve: () => void } | null = null;
  let closed = "";
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
  return { socket, messages, received };
}

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
