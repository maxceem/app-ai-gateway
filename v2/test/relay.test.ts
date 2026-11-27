/**
 * The relay Worker's entry (plan step 9a; crash table row 1): a ticket's
 * signature is checked with the main Worker's public key before any session
 * object is created, and the ticket names its object.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { HEALTH_PATH, RECONNECT_FIRST_MESSAGE_MS, SESSION_PATH } from "../relay/src/constants.js";
import relay, { Session } from "../relay/src/index.js";
import { MAX_CLIENT_FRAMES_PER_WINDOW, SessionFrames, StartQueue } from "../relay/src/frames.js";
import { issueTicket } from "../src/relay/tickets.ts";
import { sealForTest } from "./split-keys.ts";
import { TEST_TICKET_PUBLIC_KEY } from "./relay-keys.ts";
import { ACCOUNT_ID } from "./helpers.ts";

/** A session namespace that records whether anything reached it, and which object. */
function sessions() {
  const used: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      used.push(`idFromName:${name}`);
      return name;
    },
    get: () => {
      used.push("get");
      return { fetch: async () => new Response("from the session", { status: 200 }) };
    },
  };
  return { used, namespace: namespace as unknown as DurableObjectNamespace };
}

const relayEnv = (namespace: DurableObjectNamespace, key: string | null = TEST_TICKET_PUBLIC_KEY) =>
  ({ SESSION: namespace, MAIN: {}, VAULT: {}, ...(key === null ? {} : { RELAY_TICKET_PUBLIC_KEY: key }) }) as unknown as Parameters<typeof relay.fetch>[1];

const connect = (ticket: string | null, upgrade = true) =>
  new Request(`https://relay.example${SESSION_PATH}`, {
    headers: { ...(upgrade ? { upgrade: "websocket" } : {}), ...(ticket === null ? {} : { authorization: `Bearer ${ticket}` }) },
  });

async function signed(mode: "relayed" | "observed" = "relayed"): Promise<{ ticket: string; sessionId: string }> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_entry", "openai", "", "", ""];
  const blob = await sealForTest("providerKey", identity, "sk-entry");
  return await issueTicket(env, {
    accountId: ACCOUNT_ID,
    appId: "app_entry",
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: "conn_entry",
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode,
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    capMs: 60_000,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
  });
}

describe("the relay's entry", () => {
  it("answers its health check, and a 404 for any other path", async () => {
    const response = await relay.fetch(new Request(`https://relay.example${HEALTH_PATH}`), relayEnv(sessions().namespace));
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway-relay" });
    expect((await relay.fetch(new Request("https://relay.example/v2/relay/echo"), relayEnv(sessions().namespace))).status).toBe(404);
  });

  it("row 1: a missing, made-up, cut or forged ticket creates no session object", async () => {
    const { ticket } = await signed();
    const [payload, signature = ""] = ticket.split(".");
    const flipped = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    for (const bad of [null, "not-a-ticket", ticket.slice(0, 60), flipped]) {
      const { used, namespace } = sessions();
      const response = await relay.fetch(connect(bad), relayEnv(namespace));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "ticket_refused" } });
      expect(used).toEqual([]);
    }
  });

  it("asks for a WebSocket, and never takes the ticket from the URL", async () => {
    const { ticket } = await signed();
    const plain = sessions();
    expect((await relay.fetch(connect(ticket, false), relayEnv(plain.namespace))).status).toBe(426);
    const inUrl = sessions();
    const response = await relay.fetch(new Request(`https://relay.example${SESSION_PATH}?ticket=${ticket}`, { headers: { upgrade: "websocket" } }), relayEnv(inUrl.namespace));
    expect(response.status).toBe(401);
    expect(plain.used).toEqual([]);
    expect(inUrl.used).toEqual([]);
  });

  it("hands a signed ticket to the session object it names", async () => {
    const { ticket, sessionId } = await signed();
    const { used, namespace } = sessions();
    const response = await relay.fetch(connect(ticket), relayEnv(namespace));
    expect(await response.text()).toBe("from the session");
    expect(used).toEqual([`idFromName:${sessionId}`, "get"]);
  });

  it("refuses an observed session until observed mode is built (part 3), and a relay without its key", async () => {
    const observed = sessions();
    expect((await relay.fetch(connect((await signed("observed")).ticket), relayEnv(observed.namespace))).status).toBe(501);
    expect(observed.used).toEqual([]);
    const unset = sessions();
    expect((await relay.fetch(connect((await signed()).ticket), relayEnv(unset.namespace, null))).status).toBe(503);
    expect(unset.used).toEqual([]);
  });
});

describe("the session object's start (Sol, #260 round 2)", () => {
  it("a provider queue that overflowed during the start ends the session with 4000 start_queue_full: the owning start's close", async () => {
    const pending = new StartQueue();
    while (pending.push("x".repeat(64 * 1024)));
    const ended: string[] = [];
    const sent: unknown[] = [];
    const closes: string[] = [];
    // The session object without its constructor: a stand-in core, as the start leaves it.
    const session = Object.create(Session.prototype) as Session;
    session.live = null;
    const core: Record<string, unknown> = {
      owner: null,
      // As the real core: a started session belongs to the client that started it.
      start: async (_ticket: string, _payload: unknown, client: unknown) => ((core.owner = client), { ok: true, reconnectSecret: "secret", deadline: Date.now() + 60_000, call: { callId: null, forward: null, pending, send: (data: unknown) => sent.push(data), close: () => closes.push("provider") } }),
      end: async (reason: string) => void ended.push(reason),
      clientGone: async () => undefined,
      startedBy: () => true,
    };
    (session as unknown as { core: unknown }).core = core;
    const client = {
      addEventListener: () => undefined,
      send: (data: unknown) => sent.push(data),
      close: (code: number, reason: string) => closes.push(`${code} ${reason}`),
    } as unknown as WebSocket;
    await session.begin(client, "ticket", { sid: "ses_flood" } as never, true);
    expect(closes).toEqual(["4000 start_queue_full"]);
    expect(ended).toEqual(["error"]);
    // Nothing announced, nothing forwarded.
    expect(sent).toEqual([]);
  });

  it("a client too slow is ended through the core, which sets its close code; a turned-away connection never ends the session (Fable, #260 round 1)", () => {
    const ended: string[] = [];
    const closes: string[] = [];
    const owner = { close: () => undefined };
    const session = Object.create(Session.prototype) as Session;
    (session as unknown as { core: unknown }).core = { owner, end: async (reason: string) => void ended.push(reason) };
    const client = { close: (code: number, reason: string) => closes.push(`${code} ${reason}`), send: () => undefined } as unknown as WebSocket;
    const live = (verdict: unknown, liveOwner: unknown) =>
      ({ client, owner: liveOwner, frames: { fromClient: () => verdict }, call: null, deadline: Infinity, queue: new StartQueue() }) as never;
    // The session's own client falls behind: the core ends it, and closes the client with its code.
    session.fromClient(live({ kind: "end", reason: "client_too_slow" }, owner), "report");
    expect(ended).toEqual(["client_too_slow"]);
    expect(closes).toEqual([]);
    // A connection that was turned away sends a frame too large: it is closed, the session runs on.
    session.fromClient(live({ kind: "end", reason: "error", closeCode: 1009, closeReason: "frame_too_large" }, { close: () => undefined }), "big");
    expect(closes).toEqual(["1009 frame_too_large"]);
    expect(ended).toEqual(["client_too_slow"]);
  });
});

describe("our SDK's link dropping (step 9a part 3)", () => {
  /** The session object without its constructor, its core a stand-in that records what it was told. */
  function dropped(options: { relayMessages: boolean; detached: "hold" | "end"; code: number }) {
    const told: string[] = [];
    const owner = { close: () => undefined };
    const session = Object.create(Session.prototype) as Session;
    const core = {
      detach: (client: unknown) => (told.push("detach"), client === owner),
      clientGone: async () => void told.push("clientGone"),
    };
    (session as unknown as { core: unknown }).core = core;
    const live = {
      client: {} as WebSocket,
      owner,
      frames: { detached: false },
      relayMessages: options.relayMessages,
      adapter: { detached: options.detached },
    } as never as { client: WebSocket | null; frames: { detached: boolean } };
    session.live = live as never;
    session.clientClosed(live as never, owner, options.code);
    return { told, live };
  }

  it("leaves the session running for our SDK to come back, when its link drops and the adapter holds frames", () => {
    const { told, live } = dropped({ relayMessages: true, detached: "hold", code: 1006 });
    expect(told).toEqual(["detach"]);
    expect(live.client).toBeNull();
    expect(live.frames.detached).toBe(true);
  });

  it("ends it on a deliberate close (1000, 1001, or 1005 with no code), for an official SDK, and for a protocol whose rule is to end", () => {
    for (const options of [
      { relayMessages: true, detached: "hold" as const, code: 1000 },
      { relayMessages: true, detached: "hold" as const, code: 1001 },
      // A close with no code is deliberate too (Fable, #263 round 1).
      { relayMessages: true, detached: "hold" as const, code: 1005 },
      { relayMessages: false, detached: "hold" as const, code: 1006 },
      { relayMessages: true, detached: "end" as const, code: 1006 },
    ]) {
      const { told, live } = dropped(options);
      expect(told, JSON.stringify(options)).toEqual(["clientGone"]);
      expect(live.client).not.toBeNull();
    }
  });

  it("holds the provider's frames while no client is attached, and ends the session when they don't fit, counting that frame's usage first (Sol round 1)", () => {
    const ended: string[] = [];
    const counted: unknown[] = [];
    const session = Object.create(Session.prototype) as Session;
    // As the real core: an end in flight stops usage from being recorded, outside the closing wait.
    const core: Record<string, unknown> = {
      ending: null,
      end: (reason: string) => {
        ended.push(reason);
        core.ending = Promise.resolve();
        return core.ending;
      },
      recordUsage: async (event: unknown) => void (core.ending === null && counted.push(event)),
      turnDone: () => undefined,
    };
    (session as unknown as { core: unknown }).core = core;
    const usage = { id: "u1", measures: { input_tokens: 5 } };
    const live = { client: null, deadline: Infinity, held: new StartQueue(), turnOpen: false, adapter: { shape: "per_turn", read: (data: unknown) => (data === "usage" ? usage : null), turn: (data: unknown) => (data === "usage" ? "open" : null) } } as never as { held: StartQueue; turnOpen: boolean };
    session.toClient(live as never, "first");
    expect(live.held.frames).toEqual(["first"]);
    expect(ended).toEqual([]);
    while (live.held.push("x".repeat(64 * 1024)));
    // The frame that doesn't fit carries usage and opens an answer: both are read before the end.
    session.toClient(live as never, "usage");
    expect(ended).toEqual(["client_closed"]);
    expect(counted).toEqual([usage]);
    expect(live.turnOpen).toBe(true);
  });

  it("lets go of the held frames when the provider call closes, and only for the session's own call (Sol round 3)", () => {
    const session = Object.create(Session.prototype) as Session;
    const call = {};
    const held = new StartQueue();
    held.push("waiting");
    session.live = { call, held } as never;
    session.dropHeld({} as never);
    expect(held.frames).toEqual(["waiting"]);
    session.dropHeld(call as never);
    expect(held.frames).toEqual([]);
  });

  /** A session object whose detached client comes back with the right secret, through `reconnect`. */
  async function comeBack(
    frames: SessionFrames,
    options: { deadline?: number; secret?: string | null; whileWaiting?: (core: Record<string, unknown>) => void; closeWhileHashing?: boolean } = {},
  ) {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const sent: unknown[] = [];
    const closes: string[] = [];
    const socket = {
      addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] ??= []).push(listener),
      removeEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener)),
      send: (data: unknown) => sent.push(data),
      close: (code: number, reason: string) => closes.push(`${code} ${reason}`),
    } as unknown as WebSocket;
    const session = Object.create(Session.prototype) as Session;
    // A running session: the core still holds its provider call, and nothing is ending.
    const core: Record<string, unknown> = {
      call: {},
      ending: null,
      mayReattach: async (secret: unknown) => {
        // The link closes while the secret is hashed.
        if (options.closeWhileHashing === true) for (const listener of listeners.close ?? []) listener({ code: 1006 });
        return secret === "right";
      },
      reattach: () => true,
    };
    (session as unknown as { core: unknown }).core = core;
    const live = { client: null, owner: {}, frames, call: null, deadline: options.deadline ?? Date.now() + 60_000, queue: new StartQueue(), held: new StartQueue(), relayMessages: true, adapter: {}, turnOpen: false };
    session.live = live as never;
    const coming = session.reconnect(socket);
    // What changes while the link waits for its first message.
    options.whileWaiting?.(core);
    if (options.secret !== null) for (const listener of listeners.message ?? []) listener({ data: JSON.stringify({ type: "agw.reconnect", secret: options.secret ?? "right" }) });
    await coming;
    return { live, sent, closes };
  }

  it("a reconnect whose session is gone by its first message is told session_ended, not the retryable session_active (Sol round 4)", async () => {
    // The provider hung up, an end began, or the deadline passed, while the link waited.
    for (const [name, options] of [
      ["provider closed", { whileWaiting: (core: Record<string, unknown>) => (core.call = null) }],
      ["ending", { whileWaiting: (core: Record<string, unknown>) => (core.ending = new Promise(() => undefined)) }],
      ["past the deadline", { deadline: Date.now() - 1 }],
      ["past the deadline, wrong secret", { deadline: Date.now() - 1, secret: "wrong" }],
    ] as const) {
      const { sent, closes } = await comeBack(new SessionFrames({ relayMessages: true }), options);
      expect(closes, name).toEqual(["4000 session_ended"]);
      expect(sent, name).toEqual([]);
    }
    // A failed proof on a live session is the only session_active.
    expect((await comeBack(new SessionFrames({ relayMessages: true }), { secret: "wrong" })).closes).toEqual(["4000 session_active"]);
  });

  it("a reconnect to a session already ending is told session_ended at once, without waiting for its first message (Sol round 6)", () => {
    const closes: string[] = [];
    const socket = { addEventListener: () => undefined, removeEventListener: () => undefined, send: () => undefined, close: (code: number, reason: string) => closes.push(`${code} ${reason}`) } as unknown as WebSocket;
    const session = Object.create(Session.prototype) as Session;
    (session as unknown as { core: unknown }).core = { call: {}, ending: new Promise(() => undefined) };
    session.live = { client: null, deadline: Date.now() + 60_000 } as never;
    void session.reconnect(socket);
    expect(closes).toEqual(["4000 session_ended"]);
  });

  it("a link that closes while its secret is hashed never joins: the session holds no dead socket (Fable, #263 round 1)", async () => {
    const { live, sent } = await comeBack(new SessionFrames({ relayMessages: true }), { closeWhileHashing: true });
    expect(live.client).toBeNull();
    expect(sent).toEqual([]);
  });

  it("turns away a link that sends nothing within the first-message window (Fable, #263 round 1)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { live, closes } = await comeBack(new SessionFrames({ relayMessages: true }), {
        secret: null,
        whileWaiting: () => vi.advanceTimersByTime(RECONNECT_FIRST_MESSAGE_MS),
      });
      // A live session: the refusal any second connection gets.
      expect(closes).toEqual(["4000 session_active"]);
      expect(live.client).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect keeps the frame-rate window: a new link brings no fresh allowance (Sol round 2)", async () => {
    const frames = new SessionFrames({ relayMessages: true });
    // The old link used up this window's allowance.
    for (let frame = 0; frame < MAX_CLIENT_FRAMES_PER_WINDOW; frame += 1) expect(frames.fromClient("x").kind).toBe("forward");
    const { live } = await comeBack(frames);
    expect(live.frames.fromClient("one more")).toEqual({ kind: "end", reason: "error", closeCode: 1008, closeReason: "rate_limited" });
  });

  it("a client that comes back with the secret counts as there: the next checkpoint says connected (Sol round 1)", async () => {
    // A session whose client never spoke before its link dropped.
    const frames = new SessionFrames({ relayMessages: true });
    expect(frames.clientSpoke).toBe(false);
    const deadline = Date.now() + 60_000;
    const { live, sent } = await comeBack(frames, { deadline });
    expect(sent).toEqual([JSON.stringify({ type: "agw.session.resumed", deadline })]);
    // What the core's `proof` reads for the next checkpoint.
    expect(live.frames.clientSpoke).toBe(true);
  });
});
