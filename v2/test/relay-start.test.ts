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

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
  }
}

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

function setup(options: { vault?: () => Promise<unknown>; open?: () => Promise<unknown>; connect?: () => Promise<{ callId: string | null }>; close?: () => Promise<unknown> } = {}) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const calls = { vault: 0, open: 0, connect: 0, close: [] as { endReason: string; finalSlice: number }[] };
  const logs: Record<string, unknown>[] = [];
  /** A test's way to run something when the provider's socket closes, as the session object's listener does. */
  const hooks: { onProviderClose?: (call: unknown) => void } = {};
  /** What each side was told when the session ended: the client's reason, the provider's close. */
  const ended = { client: [] as string[], provider: [] as [number, string][] };
  const parts = () => ({
    store,
    now: () => now,
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
    client: () => ({ close: (_code: number, reason: string) => ended.client.push(reason) }),
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
    // The first wakeup comes one checkpoint interval in (row 13).
    expect(s.store.alarm).toBe(s.now() + 60_000);
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
    // One checkpoint interval in, not the deadline.
    expect(wakeup).toBe(s.now() + 60_000);
    expect(wakeup).toBeLessThan(s.ticket.start + s.ticket.cap);
    s.tick(wakeup - s.now());
    await s.instance().alarm();
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
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
    expect(await started).toEqual({ ok: false, code: "session_ended" });
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
    // The first wakeup finds the provider still there and waits for the deadline.
    s.tick(s.store.alarm! - s.now());
    await core.alarm();
    expect(s.store.alarm).toBe(s.ticket.start + s.ticket.cap);
    s.tick(s.store.alarm! - s.now());
    await core.alarm();
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 0 }]);
    expect(s.ended).toEqual({ client: ["time_cap"], provider: [[1000, "session ended"]] });
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
});
