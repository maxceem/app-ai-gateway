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
  /** Whether a write froze: the instance that made it never goes on. */
  frozen = false;

  async get(keys: string[]): Promise<Map<string, unknown>> {
    return new Map(keys.filter((key) => this.data.has(key)).map((key) => [key, structuredClone(this.data.get(key))]));
  }

  put(entries: Record<string, unknown>, alarmAt: number | null): Promise<void> {
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
  const parts = () => ({
    name: "ses_1",
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
        return await (options.connect?.() ?? Promise.resolve({ callId: null }));
      },
    },
  });
  const { text, ticket } = ticketFor(now);
  return {
    store,
    calls,
    logs,
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
    expect(s.store.alarm).toBe(s.ticket.start + s.ticket.cap);
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

  it("refuses a ticket for another session object", async () => {
    const s = setup();
    const other = ticketFor(s.now(), { sid: "ses_other" });
    expect(await s.instance().start(other.text, other.ticket)).toEqual({ ok: false, code: "ticket_refused" });
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
    expect(await s.instance().start(s.text, s.ticket)).toEqual({ ok: false, code: "provider_unavailable" });
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
  });

  it("row 13, relayed: a restart after active lost the provider socket: the session ends", async () => {
    const s = setup();
    await s.instance().start(s.text, s.ticket);
    s.tick(1_000);
    await s.instance().alarm();
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
  });

  it("ends at its deadline with time_cap", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket);
    s.tick(s.ticket.cap);
    await core.alarm();
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: 0 }]);
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
