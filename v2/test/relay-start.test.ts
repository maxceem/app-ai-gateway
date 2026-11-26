/**
 * A session's start and end (`relay/src/start.js`), against stand-ins: the
 * crash table's rows 4–13, 25 and 28 for relayed sessions.
 *
 * How a crash is made (crash table, "Before the tests are written"): the
 * stand-in storage or a port can freeze at a named point, so the instance
 * never goes on; then a new `SessionCore` over the same storage is the
 * restarted object. The clock is the test's.
 */
import { describe, expect, it } from "vitest";
import { TICK_MS } from "../relay/src/frames.js";
import { CLOSE_RETRY_EVERY_MS, CLOSE_RETRY_MS, ProviderRefused, SessionCore } from "../relay/src/start.js";
import { base64url, type Ticket } from "../relay/src/ticket.js";

const never = <T>() => new Promise<T>(() => undefined);

/** Lets pending promise steps run until `done` holds: no real timer, only the microtask queue. */
async function until(done: () => boolean): Promise<void> {
  for (let step = 0; step < 1_000 && !done(); step += 1) await Promise.resolve();
  if (!done()) throw new Error("the condition never held");
}

/** Storage that keeps what was written, applies each `put` whole, and can freeze on a chosen write. */
class MemoryStore {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  freezeWhen: ((entries: Record<string, unknown>) => boolean) | null = null;
  /** Runs before a write is applied: a test's way to land an event during that write. */
  beforePut: ((entries: Record<string, unknown>) => void) | null = null;
  /** Throws on the chosen read: a test's way to make storage fail. */
  failGet: ((keys: string[]) => boolean) | null = null;
  /** Whether a write froze: the instance that made it never goes on. */
  frozen = false;

  async get(keys: string[]): Promise<Map<string, unknown>> {
    if (this.failGet?.(keys)) throw new Error("storage failed");
    return new Map(keys.filter((key) => this.data.has(key)).map((key) => [key, structuredClone(this.data.get(key))]));
  }

  put(entries: Record<string, unknown>, alarmAt: number | null): Promise<void> {
    this.beforePut?.(entries);
    if (this.freezeWhen?.(entries)) {
      this.frozen = true;
      return never();
    }
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value));
    if (alarmAt !== null) this.alarm = alarmAt;
    return Promise.resolve();
  }

  /** The journal's own write: one key, no alarm. */
  putJournal(journal: unknown): Promise<void> {
    return this.put({ journal }, null);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
  }
}

/** What the main Worker's `checkpoint` stand-in got. */
interface CheckpointSeen {
  slice: { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number } | null;
  connected: boolean;
  accounting: boolean;
}

/** A checkpoint reply: continue and written, unless a test says otherwise. */
type Reply = { decision: "continue" | "stop"; reasons: string[]; written: boolean };

function ticketFor(now: number, overrides: Partial<Ticket> = {}): { text: string; ticket: Ticket } {
  const ticket: Ticket = {
    v: 1,
    sid: "ses_1",
    account: "acc",
    app: "app",
    endUser: "user",
    install: null,
    appleAccount: null,
    appKey: null,
    providerType: "openai",
    connection: "conn",
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode: "relayed",
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    start: now,
    cap: 30 * 60_000,
    exp: now + 60_000,
    seal: {},
    ...overrides,
  };
  // The core never checks the signature (the entry did); a well-formed one is enough here.
  return { ticket, text: `${base64url(new TextEncoder().encode(JSON.stringify(ticket)))}.${base64url(new Uint8Array(64))}` };
}

function setup(
  options: {
    vault?: () => Promise<unknown>;
    open?: () => Promise<unknown>;
    connect?: () => Promise<{ callId: string | null }>;
    close?: () => Promise<unknown>;
    liveness?: (now: number) => string | null;
    checkpoint?: (input: CheckpointSeen) => Promise<Reply>;
    proof?: () => boolean;
    checkpointTimeoutMs?: number;
    turnOpen?: () => boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const calls = { vault: 0, open: 0, connect: 0, close: [] as { endReason: string; finalSlice: number }[], checkpoints: [] as CheckpointSeen[] };
  const logs: Record<string, unknown>[] = [];
  /** A test's way to run something when the provider's socket closes, as the session object's listener does. */
  const hooks: { onProviderClose?: (call: unknown) => void } = {};
  /** What each side was told when the session ended: the client's reason, the provider's close. */
  const ended = { client: [] as string[], provider: [] as [number, string][], clientCodes: [] as number[] };
  const parts = () => ({
    store,
    now: () => now,
    ...(options.liveness === undefined ? {} : { liveness: options.liveness }),
    ...(options.proof === undefined ? {} : { proof: options.proof }),
    ...(options.checkpointTimeoutMs === undefined ? {} : { checkpointTimeoutMs: options.checkpointTimeoutMs }),
    ...(options.turnOpen === undefined ? {} : { turnOpen: options.turnOpen }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    log: (event: Record<string, unknown>) => logs.push(event),
    vault: {
      sessionKey: async () => {
        calls.vault += 1;
        return (await (options.vault?.() ?? Promise.resolve({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }))) as never;
      },
    },
    main: {
      open: async () => {
        calls.open += 1;
        return (await (options.open?.() ?? Promise.resolve({ deadline: now + 30 * 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 1 }))) as never;
      },
      checkpoint: async (_ticket: string, input: CheckpointSeen) => {
        const seen = structuredClone(input);
        calls.checkpoints.push(seen);
        return (await (options.checkpoint?.(seen) ?? Promise.resolve({ decision: "continue", reasons: [], written: true }))) as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number }) => {
        calls.close.push({ endReason: input.endReason, finalSlice: input.finalSlice });
        return await (options.close?.() ?? Promise.resolve({ version: 1 }));
      },
    },
    provider: {
      connect: async () => {
        calls.connect += 1;
        const answer = await (options.connect?.() ?? Promise.resolve({ callId: null }));
        const call = {
          ...answer,
          close: (code: number, reason: string) => {
            ended.provider.push([code, reason]);
            // The provider's socket closes, and its close event reaches the session at once.
            hooks.onProviderClose?.(call);
          },
        };
        return call;
      },
    },
  });
  const { text, ticket } = ticketFor(now);
  return {
    store,
    calls,
    logs,
    ended,
    hooks,
    /** A client connection: what it is told when the session ends is recorded. */
    client: () => ({
      close: (code: number, reason: string) => {
        ended.client.push(reason);
        ended.clientCodes.push(code);
      },
    }),
    text,
    ticket,
    /** A new instance over the same storage: a fresh object, or the restarted one. */
    instance: () => new SessionCore(parts()),
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("a session's start", () => {
  it("starts in order, storing nothing before open succeeds, then starting with the alarm in the same write, then active", async () => {
    const s = setup();
    const result = await s.instance().start(s.text, s.ticket);
    expect(result).toMatchObject({ ok: true, deadline: s.ticket.start + s.ticket.cap });
    expect(s.calls).toMatchObject({ vault: 1, open: 1, connect: 1 });
    expect(s.store.data.get("state")).toBe("active");
    // The first tick comes one `TICK_MS` in (plan section 5; row 13).
    expect(s.store.alarm).toBe(s.now() + TICK_MS);
    // Only the reconnect secret's hash is stored.
    expect([...s.store.data.values()].map((value) => JSON.stringify(value)).join()).not.toContain((result as { reconnectSecret: string }).reconnectSecret);
  });

  it("row 4: a vault that says no or stalls changes nothing; a retry after it is back starts the session", async () => {
    let vaultUp = false;
    const s = setup({ vault: () => (vaultUp ? Promise.resolve({ target: "https://api.openai.com/v1/realtime" }) : Promise.reject(new Error("credential_unavailable"))) });
    expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "credential_unavailable" });
    expect(s.calls.open).toBe(0);
    expect(s.store.data.size).toBe(0);
    expect(s.store.alarm).toBeNull();
    vaultUp = true;
    expect(await s.instance().start(s.text, s.ticket)).toMatchObject({ ok: true });
    expect(s.calls.connect).toBe(1);
  });

  it("rows 5 and 6: open fails or its reply is lost: nothing stored, and a retry with the same ticket gives one session", async () => {
    let openUp = false;
    const s = setup({ open: () => (openUp ? Promise.resolve({ deadline: 0, mode: "relayed", operation: "x", checkpointIntervalMs: 1, version: 1 }) : Promise.reject(new Error("unavailable"))) });
    expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "open_failed" });
    expect(s.store.data.size).toBe(0);
    openUp = true;
    expect(await s.instance().start(s.text, s.ticket)).toMatchObject({ ok: true });
    expect(s.calls).toMatchObject({ open: 2, connect: 1 });
  });

  it("row 5: an expired ticket is refused before anything is asked", async () => {
    const s = setup();
    s.tick(60_000);
    expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "ticket_expired" });
    expect(s.calls).toMatchObject({ vault: 0, open: 0 });
  });

  it("row 8: a second connection while a start is in flight gets an error and never reaches the provider; after active, the ticket is refused", async () => {
    let release: (value: { callId: string | null }) => void = () => undefined;
    const s = setup({ connect: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const first = core.start(s.text, s.ticket);
    expect(await core.start(s.text, s.ticket)).toEqual({ ok: false, code: "start_in_flight" });
    await until(() => s.calls.connect === 1);
    expect(await core.start(s.text, s.ticket)).toEqual({ ok: false, code: "start_in_flight" });
    release({ callId: null });
    expect(await first).toMatchObject({ ok: true });
    expect(s.calls.connect).toBe(1);
    expect(await core.start(s.text, s.ticket)).toEqual({ ok: false, code: "session_active" });
  });

  it("row 9: a restart after open: a retry goes on with one provider connect; with no retry, the alarm closes at the ticket's expiry", async () => {
    const retried = setup();
    retried.store.freezeWhen = (entries) => entries.connecting === true;
    void retried.instance().start(retried.text, retried.ticket);
    await until(() => retried.store.frozen);
    expect(retried.store.data.get("state")).toBe("starting");
    // The alarm was armed in the same write as `starting`.
    expect(retried.store.alarm).toBe(retried.ticket.exp);
    retried.store.freezeWhen = null;
    expect(await retried.instance().start(retried.text, retried.ticket)).toMatchObject({ ok: true });
    expect(retried.calls).toMatchObject({ open: 1, connect: 1 });

    const abandoned = setup();
    abandoned.store.freezeWhen = (entries) => entries.connecting === true;
    void abandoned.instance().start(abandoned.text, abandoned.ticket);
    await until(() => abandoned.store.frozen);
    abandoned.store.freezeWhen = null;
    abandoned.tick(60_000);
    await abandoned.instance().alarm();
    expect(abandoned.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
    expect(abandoned.calls.connect).toBe(0);
  });

  it("rows 10 and 11: a crash once \"connecting\" is stored never connects again, and closes with error", async () => {
    for (const freeze of ["connect", "active"] as const) {
      const s = setup(freeze === "connect" ? { connect: () => never() } : {});
      if (freeze === "active") s.store.freezeWhen = (entries) => entries.state === "active";
      void s.instance().start(s.text, s.ticket);
      await until(() => (freeze === "connect" ? s.calls.connect === 1 : s.store.frozen));
      s.store.freezeWhen = null;
      // The restarted object: a retry is refused, and the alarm ends the session.
      expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "session_ended" });
      expect(s.calls.connect).toBe(1);
      expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
      expect(s.logs.some((event) => event.message === "relay_start_outcome_unknown")).toBe(true);
    }
  });

  it("row 12: the provider refuses: close with error, and the client may ask for a new session", async () => {
    const s = setup({ connect: () => Promise.reject(new ProviderRefused(503)) });
    expect(await s.instance().start(s.text, s.ticket, s.client())).toEqual({ ok: false, code: "provider_unavailable" });
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
    // The session's end didn't close the client with a bare "error": the caller tells it, with this code (Fable N1).
    expect(s.ended.client).toEqual([]);
  });

  it("row 13, relayed: a restart after active lost the provider socket: the session ends with error at the first wakeup, well before the deadline (Sol round 1)", async () => {
    const s = setup();
    await s.instance().start(s.text, s.ticket);
    const wakeup = s.store.alarm!;
    // The first tick, not the deadline.
    expect(wakeup).toBe(s.now() + TICK_MS);
    expect(wakeup).toBeLessThan(s.ticket.start + s.ticket.cap);
    s.tick(wakeup - s.now());
    await s.instance().alarm();
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 1 }]);
    // Its one slice is the connection time up to the journal's last write; the rest is a gap, delivered as accounting only (row 14).
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ accounting: true, slice: { seq: 1, sessionMs: 0, gapMs: TICK_MS, gaps: 1 } });
  });

  it("a slow provider handshake never brings back a session the alarm ended meanwhile; the provider's side is hung up (Sol round 1)", async () => {
    let release: (value: { callId: string | null }) => void = () => undefined;
    const s = setup({ connect: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const started = core.start(s.text, s.ticket);
    await until(() => s.calls.connect === 1);
    // The ticket expires while the handshake is open, and the alarm ends the session.
    s.tick(60_000);
    await core.alarm();
    expect(s.store.data.get("state")).toBe("ended");
    release({ callId: "call_late" });
    // The alarm ended it because the ticket expired: the client is told that (Fable, #258 round 3).
    expect(await started).toEqual({ ok: false, code: "ticket_expired" });
    expect(s.store.data.get("state")).toBe("ended");
    expect(s.store.data.get("callId")).toBeUndefined();
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    expect(s.calls.close).toHaveLength(1);
  });

  it("checks the ticket's expiry again right before dialing: a slow open past it never reaches the provider (Sol round 1)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const s = setup({ open: () => new Promise((resolve) => (release = resolve)) });
    const started = s.instance().start(s.text, s.ticket);
    await until(() => s.calls.open === 1);
    s.tick(60_000);
    release({ deadline: s.ticket.start + s.ticket.cap, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 1 });
    expect(await started).toEqual({ ok: false, code: "ticket_expired" });
    expect(s.calls.connect).toBe(0);
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
  });

  it("ends at its deadline with time_cap, and both peers are told: the provider's side hung up, the client's closed with the reason (Sol round 1)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    // Each tick finds the provider still there and arms the next one, until the deadline.
    const deadline = s.ticket.start + s.ticket.cap;
    for (let ticks = 0; s.store.data.get("state") === "active" && ticks < 100; ticks += 1) {
      expect(s.store.alarm).toBe(Math.min(deadline, s.now() + TICK_MS));
      s.tick(s.store.alarm! - s.now());
      await core.alarm();
    }
    expect(s.now()).toBe(deadline);
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 31 }]);
    expect(s.ended).toEqual({ client: ["time_cap"], provider: [[1000, "session ended"]], clientCodes: [1000] });
  });

  it("when the provider hangs up first, the client's socket is closed too, with the reason (Sol round 1)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.end("provider_closed");
    expect(s.ended.client).toEqual(["provider_closed"]);
    expect(s.calls.close).toEqual([{ endReason: "provider_closed", finalSlice: 0 }]);
  });
});

describe("a session's end", () => {
  it("row 25: a lost close is retried by the alarm, then given up on and logged; a repeated end changes nothing", async () => {
    let closeUp = false;
    const s = setup({ close: () => (closeUp ? Promise.resolve({ version: 1 }) : Promise.reject(new Error("unavailable"))) });
    const core = s.instance();
    await core.start(s.text, s.ticket);
    await core.end("client_closed");
    await core.end("error");
    expect(s.store.data.get("end")).toMatchObject({ reason: "client_closed" });
    s.tick(CLOSE_RETRY_EVERY_MS);
    await core.alarm();
    expect(s.calls.close).toHaveLength(2);
    closeUp = true;
    s.tick(CLOSE_RETRY_EVERY_MS);
    await core.alarm();
    expect(s.store.data.get("closed")).toBe(true);

    const lost = setup({ close: () => Promise.reject(new Error("unavailable")) });
    const other = lost.instance();
    await other.start(lost.text, lost.ticket);
    await other.end("client_closed");
    lost.tick(CLOSE_RETRY_MS);
    await other.alarm();
    expect(lost.logs.some((event) => event.message === "relay_close_given_up")).toBe(true);
    expect(lost.store.data.get("closed")).toBe(true);
  });

  it("row 28: the ended marker refuses the ticket until it expires; then storage is deleted, and an empty object stays empty", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket);
    await core.end("client_closed");
    expect(s.store.alarm).toBe(s.ticket.exp);
    expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "session_ended" });
    s.tick(60_000);
    await s.instance().alarm();
    expect(s.store.data.size).toBe(0);
    expect(s.store.alarm).toBeNull();
    await s.instance().alarm();
    expect(s.store.alarm).toBeNull();
  });
});

describe("a client that hangs up during the start (Sol round 2)", () => {
  it("while the vault answers: no open and no provider call, and nothing is stored, so there is nothing to end (Sol round 2; Fable N3)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const s = setup({ vault: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const client = s.client();
    const started = core.start(s.text, s.ticket, client);
    await until(() => s.calls.vault === 1);
    await core.clientGone(client);
    release({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" });
    expect(await started).toEqual({ ok: false, code: "client_closed" });
    expect(s.calls).toMatchObject({ open: 0, connect: 0, close: [] });
    expect(s.store.data.size).toBe(0);
  });

  it("during the provider handshake: the provider is hung up, and the session ends", async () => {
    let release: (value: { callId: string | null }) => void = () => undefined;
    const s = setup({ connect: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const client = s.client();
    const started = core.start(s.text, s.ticket, client);
    await until(() => s.calls.connect === 1);
    await core.clientGone(client);
    release({ callId: null });
    expect(await started).toEqual({ ok: false, code: "client_closed" });
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 0 }]);
    expect(s.store.data.get("state")).toBe("ended");
  });

  it("a second connection turned away does nothing to the running session when it closes (Sol round 3)", async () => {
    const s = setup();
    const core = s.instance();
    const first = s.client();
    expect(await core.start(s.text, s.ticket, first)).toMatchObject({ ok: true });
    const second = s.client();
    expect(await core.start(s.text, s.ticket, second)).toEqual({ ok: false, code: "session_active" });
    await core.clientGone(second);
    expect(s.store.data.get("state")).toBe("active");
    expect(s.ended.provider).toEqual([]);
    expect(s.calls.close).toEqual([]);
    // The session's own client still ends it.
    await core.clientGone(first);
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 0 }]);
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
  });

  it("a hang-up that lands during the active write is caught by the check after it: the session ends (Fable F1)", async () => {
    const s = setup();
    const core = s.instance();
    const client = s.client();
    s.store.beforePut = (entries) => {
      if (entries.state === "active") void core.clientGone(client);
    };
    expect(await core.start(s.text, s.ticket, client)).toEqual({ ok: false, code: "client_closed" });
    await until(() => s.calls.close.length === 1);
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 0 }]);
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    expect(s.store.data.get("state")).toBe("ended");
  });

  it("a storage failure after the provider connected never leaves its call behind (Fable F2)", async () => {
    const s = setup();
    let reads = 0;
    s.store.failGet = (keys) => keys.length === 1 && keys[0] === "state" && (reads += 1) === 2;
    await expect(s.instance().start(s.text, s.ticket, s.client())).rejects.toThrow("storage failed");
    expect(s.calls.connect).toBe(1);
    expect(s.ended.provider).toEqual([[1011, "relay error"]]);
  });

  it("a second connection whose start meets a storage error never touches the running session (Gemini Neon 1)", async () => {
    const s = setup();
    const core = s.instance();
    const first = s.client();
    expect(await core.start(s.text, s.ticket, first)).toMatchObject({ ok: true });
    s.store.failGet = () => true;
    const second = s.client();
    expect(await core.start(s.text, s.ticket, second)).toEqual({ ok: false, code: "session_active" });
    expect(core.startedBy(second)).toBe(false);
    s.store.failGet = null;
    expect(s.store.data.get("state")).toBe("active");
    expect(s.ended.provider).toEqual([]);
    expect(core.call).not.toBeNull();
  });

  it("an end that hangs up the provider, whose close fires during it, stores one reason and sends one close (Gemini Neon 2)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    // As if the session object's listener sent the provider's close straight to `end`.
    s.hooks.onProviderClose = () => void core.end("provider_closed");
    await core.end("time_cap");
    await until(() => s.calls.close.length >= 1);
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 0 }]);
    expect(s.store.data.get("end")).toMatchObject({ reason: "time_cap" });
  });

  it("a handshake that finishes past expiry, with the provider's close firing during stop: the client gets ticket_expired, and one close says error (Gemini Neon 2)", async () => {
    let release: (value: { callId: string | null }) => void = () => undefined;
    const s = setup({ connect: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    s.hooks.onProviderClose = (call) => void core.providerGone(call as never);
    const started = core.start(s.text, s.ticket, s.client());
    await until(() => s.calls.connect === 1);
    s.tick(60_000);
    release({ callId: null });
    expect(await started).toEqual({ ok: false, code: "ticket_expired" });
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
    expect(s.ended.client).toEqual([]);
  });

  it("the provider's close for a call the session no longer holds changes nothing (Gemini Neon 2)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.providerGone({ callId: null });
    expect(s.store.data.get("state")).toBe("active");
    expect(s.calls.close).toEqual([]);
  });

  it("an end that found nothing to end never swallows a later session's ends: a retry on the same instance still ends (Gemini Neon round 2)", async () => {
    const s = setup();
    const core = s.instance();
    // A first start fails on a storage error before anything is stored, and the session object then calls end("error").
    s.store.failGet = () => true;
    await expect(core.start(s.text, s.ticket, s.client())).rejects.toThrow("storage failed");
    s.store.failGet = null;
    await core.end("error");
    expect(s.store.data.size).toBe(0);
    // The client retries with the same ticket on the same instance.
    const client = s.client();
    expect(await core.start(s.text, s.ticket, client)).toMatchObject({ ok: true });
    await core.clientGone(client);
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 0 }]);
    expect(s.store.data.get("state")).toBe("ended");

    // And the deadline alarm ends a retried session too.
    const t = setup();
    const again = t.instance();
    t.store.failGet = () => true;
    await expect(again.start(t.text, t.ticket, t.client())).rejects.toThrow("storage failed");
    t.store.failGet = null;
    await again.end("error");
    expect(await again.start(t.text, t.ticket, t.client())).toMatchObject({ ok: true });
    t.tick(t.ticket.cap);
    await again.alarm();
    expect(t.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 1 }]);
  });

  it("a start that comes while an end is in flight is refused (Gemini Neon round 2)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const s = setup({ close: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    const ending = core.end("client_closed");
    expect(await core.start(s.text, s.ticket, s.client())).toEqual({ ok: false, code: "start_in_flight" });
    await until(() => s.calls.close.length === 1);
    release({ version: 1 });
    await ending;
  });

  it("the alarm ticks every TICK_MS while the session runs, arming the next tick before its checks (crash table row 29)", async () => {
    let failing = true;
    const s = setup({
      liveness: () => {
        if (failing) throw new Error("a check failed");
        return null;
      },
    });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    s.tick(TICK_MS);
    // The check throws: the next tick is armed already, so the session keeps its tick.
    await expect(core.alarm()).rejects.toThrow("a check failed");
    expect(s.store.alarm).toBe(s.now() + TICK_MS);
    expect(s.store.data.get("state")).toBe("active");
    failing = false;
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.store.alarm).toBe(s.now() + TICK_MS);
    expect(s.calls.close).toEqual([]);
  });

  it("a tick ends the session with the reason the live session's checks give: a silent client, a client too far behind", async () => {
    for (const reason of ["heartbeat_timeout", "client_too_slow"]) {
      const s = setup({ liveness: () => reason });
      const core = s.instance();
      await core.start(s.text, s.ticket, s.client());
      s.tick(TICK_MS);
      await core.alarm();
      expect(s.calls.close).toEqual([{ endReason: reason, finalSlice: 1 }]);
      expect(s.ended.client).toEqual([reason]);
      // One place sets the code, for the tick and the report path alike: 4000 with the reason (Sol and Fable, #260).
      expect(s.ended.clientCodes).toEqual([4000]);
      expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    }
  });

  it("when the alarm ends a session whose start is still in flight, the client is told by the start, with 4000 and the reason, never a bare 1000 error (Fable, #258 round 3)", async () => {
    let release: (value: { callId: string | null }) => void = () => undefined;
    const s = setup({ connect: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const started = core.start(s.text, s.ticket, s.client());
    await until(() => s.calls.connect === 1);
    s.tick(60_000);
    await core.alarm();
    // The alarm closed nothing on the client's side: the start does, with its code.
    expect(s.ended.client).toEqual([]);
    release({ callId: null });
    expect(await started).toEqual({ ok: false, code: "ticket_expired" });
    expect(s.ended.client).toEqual([]);
  });

  it("an activation whose write is held past the deadline ends the session with time_cap, not a running session (Sol, #260 round 1)", async () => {
    const s = setup();
    const deadline = s.ticket.start + s.ticket.cap;
    // The `active` write takes so long that the deadline passes during it.
    s.store.beforePut = (entries) => {
      if (entries.state === "active") s.tick(deadline - s.now());
    };
    const result = await s.instance().start(s.text, s.ticket, s.client());
    expect(result).toEqual({ ok: false, code: "session_ended" });
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 1 }]);
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    // The start tells the client, with its code: nothing closed it from the end.
    expect(s.ended.client).toEqual([]);
  });
});

describe("checkpoints and the journal (step 9a part 2)", () => {
  const usage = (id: string, input = 10, output = 20) => ({ id, measures: { input_tokens: input, output_tokens: output } });

  it("sends its first checkpoint empty, then the usage since in the next slice, a repeated event counted once (call order step 9; row 15)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.checkpoint();
    expect(s.calls.checkpoints).toEqual([{ slice: null, connected: false, accounting: false, providerCallId: null, relayVersion: 2 }]);
    await core.recordUsage(usage("e1"), "per_turn");
    await core.recordUsage(usage("e1"), "per_turn");
    await core.recordUsage(usage("e2", 1, 2), "per_turn");
    s.tick(60_000);
    await core.alarm();
    expect(s.calls.checkpoints.at(-1)?.slice).toMatchObject({ seq: 1, measures: { input_tokens: 11, output_tokens: 22 }, sessionMs: 60_000, gapMs: 0 });
    // Confirmed: the journal holds nothing unsent.
    expect((s.store.data.get("journal") as { unsent: unknown[] }).unsent).toEqual([]);
  });

  it("keeps a slice until a reply says it is written: a lost reply, a timeout, or written false send the same slice again (row 16)", async () => {
    const replies: (() => Promise<Reply>)[] = [
      () => Promise.reject(new Error("lost")),
      () => never(),
      () => Promise.resolve({ decision: "continue", reasons: [], written: false }),
      () => Promise.resolve({ decision: "continue", reasons: [], written: true }),
    ];
    const s = setup({ checkpoint: async () => (replies.shift() ?? (() => Promise.resolve({ decision: "continue" as const, reasons: [], written: true })))(), checkpointTimeoutMs: 5 });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      s.tick(60_000);
      await core.checkpoint();
      // Usage after the first freeze waits for the next slice: only one is unconfirmed at a time (S6).
      await core.recordUsage(usage(`later${attempt}`), "per_turn");
    }
    const seqs = s.calls.checkpoints.map((seen) => seen.slice?.seq);
    expect(seqs).toEqual([1, 1, 1, 1]);
    expect(s.calls.checkpoints.every((seen) => seen.slice?.measures.input_tokens === 10)).toBe(true);
    s.tick(60_000);
    await core.checkpoint();
    // The next slice holds everything that came while slice 1 waited.
    expect(s.calls.checkpoints.at(-1)?.slice).toMatchObject({ seq: 2, measures: { input_tokens: 40, output_tokens: 80 } });
  });

  it("stores a slice's boundary before sending it: after a crash mid-checkpoint, later usage lands in the next slice (row 16)", async () => {
    const s = setup({ checkpoint: () => never() });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e5"), "per_turn");
    s.tick(60_000);
    // The checkpoint is sent and never answered; the instance then dies.
    void core.checkpoint();
    await until(() => s.calls.checkpoints.length === 1);
    await core.recordUsage(usage("e6", 1, 1), "per_turn");
    // A new instance: the relayed session lost its provider, so it ends and delivers both slices.
    const delivered: CheckpointSeen[] = [];
    const after = new SessionCore({
      store: s.store as never,
      now: s.now,
      log: () => undefined,
      vault: { sessionKey: async () => never() },
      main: {
        open: async () => never(),
        checkpoint: async (_ticket: string, input: CheckpointSeen) => {
          delivered.push(structuredClone(input));
          return { decision: "continue" as const, reasons: [], written: true };
        },
        close: async () => ({ version: 2 }),
      } as never,
      provider: { connect: async () => never() },
    });
    s.tick(TICK_MS);
    await after.alarm();
    expect(delivered.map((seen) => [seen.slice?.seq, seen.slice?.measures.input_tokens ?? 0, seen.accounting])).toEqual([
      [1, 10, true],
      [2, 1, true],
    ]);
  });

  it("ends on an explicit stop even when the slice wasn't written, and delivers that slice in the final delivery (rows 16, 17)", async () => {
    const s = setup({
      checkpoint: async (seen) =>
        seen.accounting ? { decision: "continue", reasons: [], written: true } : { decision: "stop", reasons: ["key_removed", "user_blocked"], written: false },
    });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    s.tick(60_000);
    await core.checkpoint();
    expect(s.calls.close).toEqual([{ endReason: "key_removed", finalSlice: 1 }]);
    expect(s.calls.checkpoints.map((seen) => [seen.slice?.seq, seen.accounting])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it("ends as replaced when the checkpoint says so, and treats the ledger's own \"ended\" as a stop logged as error", async () => {
    for (const [reasons, endReason] of [
      [["replaced"], "replaced"],
      [["ended"], "error"],
    ] as const) {
      const s = setup({ checkpoint: async (seen) => (seen.accounting ? { decision: "continue", reasons: [], written: true } : { decision: "stop", reasons: [...reasons], written: true }) });
      const core = s.instance();
      await core.start(s.text, s.ticket, s.client());
      await core.checkpoint();
      expect(s.calls.close).toEqual([{ endReason, finalSlice: 0 }]);
      // A normal close with the reason: an official SDK does not reconnect on its own (`PROTOCOL.md`).
      expect([s.ended.clientCodes, s.ended.client]).toEqual([[1000], [endReason]]);
    }
  });

  it("carries the sticky proof that a client spoke (row 20): once true, it stays true", async () => {
    let spoke = false;
    const s = setup({ proof: () => spoke });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.checkpoint();
    spoke = true;
    s.tick(60_000);
    await core.checkpoint();
    spoke = false;
    s.tick(60_000);
    await core.checkpoint();
    expect(s.calls.checkpoints.map((seen) => seen.connected)).toEqual([false, true, true]);
  });

  it("goes on while the main Worker is down, one slice unconfirmed, and books every slice in order once it is back (row 18)", async () => {
    let down = true;
    const s = setup({ checkpoint: async () => (down ? Promise.reject(new Error("unreachable")) : { decision: "continue", reasons: [], written: true }) });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    for (let minute = 0; minute < 10; minute += 1) {
      await core.recordUsage(usage(`m${minute}`, 1, 1), "per_turn");
      s.tick(60_000);
      await core.checkpoint();
      expect((s.store.data.get("journal") as { unsent: unknown[] }).unsent).toHaveLength(1);
    }
    down = false;
    await core.checkpoint();
    s.tick(60_000);
    await core.checkpoint();
    const written = s.calls.checkpoints.slice(-2).map((seen) => [seen.slice?.seq, seen.slice?.measures.input_tokens]);
    // Slice 1 had the first minute; slice 2 everything after it: nothing counted twice, nothing lost.
    expect(written).toEqual([
      [1, 1],
      [2, 9],
    ]);
  });

  it("marks a gap, not a made-up charge, when the instance died between forwarding usage and journaling it (row 14)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("kept"), "per_turn");
    // The next usage event's write never lands: the instance dies with it.
    s.store.freezeWhen = (entries) => JSON.stringify(entries).includes('"input_tokens":510');
    void core.recordUsage(usage("lost", 500, 500), "per_turn");
    await until(() => s.store.frozen);
    s.store.freezeWhen = null;
    s.tick(TICK_MS);
    await s.instance().alarm();
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 1 }]);
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ accounting: true, slice: { seq: 1, measures: { input_tokens: 10, output_tokens: 20 }, gaps: 1 } });
  });

  it("a late live reply never writes over the ended journal: the final slice stays queued for delivery (Sol round 1)", async () => {
    let release: (reply: Reply) => void = () => undefined;
    const s = setup({
      checkpoint: (seen) => {
        // The live reply for slice 1 is held; the final delivery confirms 1 and fails to write 2.
        if (!seen.accounting) return new Promise<Reply>((resolve) => (release = resolve));
        return Promise.resolve({ decision: "continue", reasons: [], written: seen.slice?.seq === 1 });
      },
    });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    s.tick(60_000);
    const live = core.checkpoint();
    await until(() => s.calls.checkpoints.length === 1);
    await core.recordUsage(usage("e2", 5, 5), "per_turn");
    s.tick(10_000);
    await core.end("client_closed");
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 2 }]);
    // Now the live reply comes, late.
    release({ decision: "continue", reasons: [], written: true });
    await live;
    expect((s.store.data.get("journal") as { unsent: { seq: number }[] }).unsent.map((slice) => slice.seq)).toEqual([2]);
    // The next retry delivers slice 2.
    s.tick(CLOSE_RETRY_EVERY_MS);
    await core.alarm();
    expect(s.calls.checkpoints.filter((seen) => seen.accounting).map((seen) => seen.slice?.seq)).toEqual([1, 2, 2]);
  });

  it("acts on an explicit stop even when the journal's write then fails, keeping the unconfirmed slice for the final delivery (Sol round 1)", async () => {
    const s = setup({
      checkpoint: async (seen) =>
        seen.accounting ? { decision: "continue", reasons: [], written: true } : { decision: "stop", reasons: ["key_removed"], written: false },
    });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    // The journal's own write fails once the checkpoint is out.
    const putJournal = s.store.putJournal.bind(s.store);
    s.store.putJournal = (journal: unknown) => (s.calls.checkpoints.length > 0 ? Promise.reject(new Error("storage failed")) : putJournal(journal));
    s.tick(60_000);
    await core.checkpoint();
    expect(s.store.data.get("state")).toBe("ended");
    expect(s.calls.close).toEqual([{ endReason: "key_removed", finalSlice: 1 }]);
    expect(s.calls.checkpoints.map((seen) => [seen.slice?.seq, seen.accounting])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it("an instance that wakes 6 minutes past a 30-minute deadline bills nothing past the cap, and keeps the crash gap (Sol round 1)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    s.tick(30_000);
    await core.recordUsage(usage("e1"), "per_turn");
    // The instance dies; a new one wakes 6 minutes after the deadline.
    const deadline = s.ticket.start + s.ticket.cap;
    s.tick(deadline + 6 * 60_000 - s.now());
    await s.instance().alarm();
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 1 }]);
    const final = s.calls.checkpoints.at(-1)?.slice as unknown as { to: number; sessionMs: number; gapMs: number; gaps: number };
    expect(final).toMatchObject({ seq: 1, to: deadline, sessionMs: 30_000, gapMs: deadline - (s.ticket.start + 30_000), gaps: 1 });
    // Within the main Worker's limit: never more than the cap.
    expect(final.sessionMs + final.gapMs).toBeLessThanOrEqual(s.ticket.cap);
  });

  it("never books a live slice past the deadline: an alarm that starts just before it and crosses it while storage writes (Sol round 2)", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    const deadline = s.ticket.start + s.ticket.cap;
    s.tick(deadline - 1 - s.now());
    // The tick's own write takes 5 s: the checkpoint after it runs past the deadline.
    s.store.beforePut = () => {
      s.store.beforePut = null;
      s.tick(5_000);
    };
    await core.alarm();
    const live = s.calls.checkpoints.find((seen) => !seen.accounting && seen.slice !== null)?.slice as unknown as { to: number; sessionMs: number };
    expect(live).toMatchObject({ to: deadline, sessionMs: deadline - s.ticket.start });
  });

  it("arms cleanup when a retry delivers the last slice after close already went through (Sol round 1)", async () => {
    let accountingUp = false;
    const s = setup({
      checkpoint: async (seen) =>
        seen.accounting && !accountingUp ? Promise.reject(new Error("down")) : { decision: "continue", reasons: [], written: !seen.accounting || accountingUp },
    });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    s.tick(60_000);
    await core.end("client_closed");
    expect(s.store.data.get("closed")).toBe(true);
    // Past the ticket's expiry, a retry (its alarm a little late) delivers the slice.
    accountingUp = true;
    s.tick(CLOSE_RETRY_EVERY_MS + 5_000);
    await core.alarm();
    expect((s.store.data.get("journal") as { unsent: unknown[] }).unsent).toEqual([]);
    expect(s.store.alarm).toBe(s.now());
    await core.alarm();
    expect(s.store.data.size).toBe(0);
  });

  it("gives up on slices it can't deliver after a while, and logs them at error (row 25)", async () => {
    const s = setup({ checkpoint: async (seen) => (seen.accounting ? Promise.reject(new Error("down")) : { decision: "continue", reasons: [], written: false }) });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    await core.recordUsage(usage("e1"), "per_turn");
    s.tick(60_000);
    await core.end("client_closed");
    s.tick(CLOSE_RETRY_MS);
    await core.alarm();
    const given = s.logs.find((line) => line.message === "relay_close_given_up") as { level: string; slices: { seq: number }[] } | undefined;
    expect(given?.level).toBe("error");
    expect(given?.slices.map((slice) => slice.seq)).toEqual([1]);
    // Then storage is cleaned up once the ticket has expired.
    s.tick(60_000);
    await core.alarm();
    expect(s.store.data.size).toBe(0);
  });
});

describe("a session's close (step 9a part 3)", () => {
  const usage = (id: string, input = 10, output = 20) => ({ id, measures: { input_tokens: input, output_tokens: output } });

  /** A timer the test fires itself: no real wait. It records how long each wait asked for. */
  function heldWait() {
    const pending: (() => void)[] = [];
    const asked: number[] = [];
    return {
      asked,
      wait: (ms: number) => {
        asked.push(ms);
        return new Promise<void>((resolve) => pending.push(resolve));
      },
      fire: () => pending.splice(0).forEach((resolve) => resolve()),
    };
  }

  const finalSliceOf = (s: ReturnType<typeof setup>) => s.calls.checkpoints.find((seen) => seen.accounting)?.slice;

  it("waits up to 10 s for the provider's answer in progress, counts its usage, then hangs up: the client is told at once (plan 5.1)", async () => {
    let answering = true;
    const timer = heldWait();
    const s = setup({ turnOpen: () => answering, wait: timer.wait });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    expect(timer.asked).toEqual([10_000]);
    // The client is told at once; the provider's side stays up for the answer.
    expect(s.ended.client).toEqual(["client_closed"]);
    expect(s.ended.provider).toEqual([]);
    // The last answer's usage arrives during the wait and still counts.
    await core.recordUsage(usage("last", 30, 40), "per_turn");
    answering = false;
    core.turnDone();
    await ending;
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    // The answer finished: nothing is missing.
    expect(finalSliceOf(s)).toMatchObject({ measures: { input_tokens: 30, output_tokens: 40 }, gaps: 0 });
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 1 }]);
  });

  it("hangs up when the answer doesn't finish within the wait: the final slice keeps its known usage and is marked partial, and later usage is not counted", async () => {
    const timer = heldWait();
    const s = setup({ turnOpen: () => true, wait: timer.wait });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    await core.recordUsage(usage("known", 5, 6), "per_turn");
    timer.fire();
    await ending;
    expect(s.ended.provider).toEqual([[1000, "session ended"]]);
    await core.recordUsage(usage("too-late"), "per_turn");
    // A gap makes the booked slice `partial` (`sliceCharge`); its known tokens are still priced.
    expect(finalSliceOf(s)).toMatchObject({ measures: { input_tokens: 5, output_tokens: 6 }, gaps: 1 });
    expect(s.logs).toContainEqual(expect.objectContaining({ level: "warn", message: "relay_answer_cut" }));
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 1 }]);
  });

  it("never waits past the deadline, and doesn't wait at the time cap: the paid connection never outlives the cap", async () => {
    const near = heldWait();
    const s = setup({ turnOpen: () => true, wait: near.wait });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    // 3 s before the deadline: the wait asks for those 3 s, not 10.
    s.tick(30 * 60_000 - 3_000);
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    expect(near.asked).toEqual([3_000]);
    near.fire();
    await ending;

    const atCap = heldWait();
    const c = setup({ turnOpen: () => true, wait: atCap.wait });
    const capped = c.instance();
    await capped.start(c.text, c.ticket, c.client());
    c.tick(60_000);
    await capped.end("time_cap");
    expect(atCap.asked).toEqual([]);
    expect(c.ended.provider).toEqual([[1000, "session ended"]]);
    // The answer was cut off at the cap: its usage is missing.
    expect(finalSliceOf(c)).toMatchObject({ sessionMs: 60_000, gaps: 1 });
  });

  it("stops waiting the moment the provider hangs up, and the session's time ends there", async () => {
    const timer = heldWait();
    const s = setup({ turnOpen: () => true, wait: timer.wait });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    s.tick(5_000);
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    s.tick(2_000);
    // Time passes after the hang-up, before the end writes: it is not the session's time.
    s.hooks.onProviderClose = () => s.tick(4_000);
    void core.providerGone(core.call as never);
    await ending;
    expect(core.turnWaiter).toBeNull();
    expect(finalSliceOf(s)).toMatchObject({ sessionMs: 7_000, gaps: 1 });
    expect(s.calls.close).toEqual([{ endReason: "client_closed", finalSlice: 1 }]);
  });

  it("ends the session's time when the provider connection ends, not after the end's storage reads, for every end (Sol rounds 2 and 3)", async () => {
    const ends: [string, (core: SessionCore) => Promise<void>][] = [
      ["provider_closed", (core) => core.providerGone(core.call as never)],
      ["client_closed", (core) => core.end("client_closed")],
      ["budget_stop", (core) => core.end("budget_stop")],
      ["time_cap", (core) => core.end("time_cap")],
    ];
    for (const [reason, endIt] of ends) {
      const s = setup();
      const core = s.instance();
      await core.start(s.text, s.ticket, s.client());
      s.tick(7_000);
      // The end's first storage read takes 4 s.
      const read = s.store.get.bind(s.store);
      let slow = true;
      s.store.get = async (keys: string[]) => {
        if (slow) {
          slow = false;
          s.tick(4_000);
        }
        return read(keys);
      };
      await endIt(core);
      expect(finalSliceOf(s), reason).toMatchObject({ sessionMs: 7_000 });
      expect(s.store.data.get("end"), reason).toMatchObject({ reason, at: s.ticket.start + 7_000 });
    }
  });

  it("doesn't wait when no answer is in progress, or when the provider hung up itself", async () => {
    for (const [answering, reason, finalSlice] of [
      [false, "client_closed", 0],
      // An answer the provider cut by hanging up is missing usage: a slice with a gap.
      [true, "provider_closed", 1],
    ] as const) {
      const timer = heldWait();
      const s = setup({ turnOpen: () => answering, wait: timer.wait });
      const core = s.instance();
      await core.start(s.text, s.ticket, s.client());
      await core.end(reason);
      expect(timer.asked).toEqual([]);
      expect(s.calls.close).toEqual([{ endReason: reason, finalSlice }]);
    }
  });

  it("refuses a new start while it waits for the answer, and the ended session never reopens", async () => {
    const timer = heldWait();
    const s = setup({ turnOpen: () => true, wait: timer.wait });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client());
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    expect(await core.start(s.text, s.ticket, s.client())).toEqual({ ok: false, code: "start_in_flight" });
    timer.fire();
    await ending;
    expect(await core.start(s.text, s.ticket, s.client())).toEqual({ ok: false, code: "session_ended" });
    expect(await s.instance().start(s.text, s.ticket, s.client())).toEqual({ ok: false, code: "session_ended" });
  });
});
