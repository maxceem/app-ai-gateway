/**
 * An observed session's life in the relay's core (`relay/src/start.js`;
 * step 9a part 3), against stand-ins: no client socket at all, one outbound
 * side channel, and reattach answers of 101, 404 and 503. It covers the crash
 * table's observed rows (8, 10–13, 20, 22–25). The start logic is the relayed
 * one; nothing here has a WebSocket.
 *
 * A crash is made as in `relay-start.test.ts`: a write freezes, or the
 * instance is dropped, and a new `SessionCore` over the same storage is the
 * restarted object. The clock is the test's.
 */
import { describe, expect, it } from "vitest";
import { TICK_MS } from "../relay/src/frames.js";
import { CLOSE_RETRY_EVERY_MS, CLOSE_RETRY_MS, ProviderRefused, SEAL_GRACE_MS, SessionCore } from "../relay/src/start.js";
import { SEAL_GRACE_MS as GATEWAY_SEAL_GRACE_MS } from "../src/relay/tickets.ts";
import { MemoryStore, never, ticketFor, until } from "./relay-stand-ins.ts";

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number };
type Seen = { slice: Slice | null; connected: boolean; accounting: boolean; providerCallId: string | null };
type Reply = { decision: "continue" | "stop"; reasons: string[]; written: boolean };
/** What an attach answers: 101 attaches, any other status is a refusal; "throw" fails with no answer. */
type AttachAnswer = 101 | 404 | 503 | "throw";

const OFFER = "v=0\r\na=x-test:offer\r\n";

function setup(
  options: {
    createCall?: () => Promise<{ callId: string; answer: string }>;
    /** The answers attaches get, in order; after the last, 101. */
    attach?: AttachAnswer[];
    vault?: (restart: boolean) => Promise<unknown>;
    hangup?: () => Promise<void>;
    checkpoint?: (input: Seen) => Promise<Reply>;
    /** Holds an attach until the test lets it go: it gets the attach's own answer once released. */
    holdAttach?: () => Promise<void>;
    turnOpen?: () => boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const attachAnswers = [...(options.attach ?? [])];
  const calls = {
    vault: [] as boolean[],
    created: 0,
    attached: 0,
    /** The longest wait each attach was given. */
    limits: [] as number[],
    hangups: [] as string[],
    checkpoints: [] as Seen[],
    close: [] as { endReason: string; finalSlice: number }[],
  };
  const logs: Record<string, unknown>[] = [];
  /** The side channels the provider handed out, in order. Closing one is the provider's close. */
  const sides: { closed: boolean; close: (code: number, reason: string) => void; callId: string | null }[] = [];
  let core: SessionCore | null = null;
  const parts = () => ({
    store,
    now: () => now,
    log: (event: Record<string, unknown>) => logs.push(event),
    ...(options.turnOpen === undefined ? {} : { turnOpen: options.turnOpen }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    vault: {
      sessionKey: async (_ticket: string, { restart }: { restart: boolean }) => {
        calls.vault.push(restart);
        return (await (options.vault?.(restart) ?? Promise.resolve({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" }))) as never;
      },
    },
    main: {
      open: async () => ({ deadline: now + 30 * 60_000, mode: "observed", operation: "openai.realtime.calls", checkpointIntervalMs: 60_000, version: 2, adapter: "mock" }),
      checkpoint: async (_ticket: string, input: Seen) => {
        const seen = structuredClone(input);
        calls.checkpoints.push(seen);
        return (await (options.checkpoint?.(seen) ?? Promise.resolve({ decision: "continue", reasons: [], written: true }))) as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number }) => {
        calls.close.push({ endReason: input.endReason, finalSlice: input.finalSlice });
        return { version: 2 };
      },
    },
    provider: {
      connect: async () => {
        throw new Error("an observed session never opens a relayed connection");
      },
      createCall: async () => {
        calls.created += 1;
        return await (options.createCall?.() ?? Promise.resolve({ callId: "rtc_1", answer: "v=0 answer" }));
      },
      attach: async (_key: unknown, callId: string, _adapter: unknown, limitMs: number) => {
        calls.attached += 1;
        calls.limits.push(limitMs);
        await options.holdAttach?.();
        const answer = attachAnswers.shift() ?? 101;
        if (answer === "throw") throw new Error("network");
        if (answer !== 101) throw new ProviderRefused(answer);
        const side = {
          closed: false,
          callId,
          close: (_code: number, _reason: string) => {
            side.closed = true;
          },
        };
        sides.push(side);
        return side;
      },
      hangup: async (_key: unknown, callId: string) => {
        await (options.hangup?.() ?? Promise.resolve());
        calls.hangups.push(callId);
      },
    },
  });
  const { text, ticket } = ticketFor(now, { mode: "observed", operation: "openai.realtime.calls", url: "https://api.openai.com/v1/realtime/calls" });
  return {
    store,
    calls,
    logs,
    sides,
    text,
    ticket,
    owner: () => ({ close: () => undefined }),
    /** A new instance over the same storage: a fresh object, or the restarted one. */
    instance: () => (core = new SessionCore(parts())),
    /** The provider closes the current side channel, as its close event reaches the session. */
    dropSide: async () => {
      const side = sides.at(-1)!;
      side.closed = true;
      await core!.sideGone(side as never);
    },
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

/** Starts an observed session and attaches its side channel, as the session object does. */
async function started(s: ReturnType<typeof setup>) {
  const core = s.instance();
  const result = await core.start(s.text, s.ticket, s.owner(), OFFER);
  expect(result).toMatchObject({ ok: true, answer: "v=0 answer", reconnectSecret: null });
  await core.attachSide();
  return core;
}

const usage = (id: string) => ({ id, measures: { input_tokens: 100, output_tokens: 20 } });

describe("an observed session's start (4.3; crash table rows 8, 10–13)", () => {
  it("creates the call from the offer, stores its id with active before the answer goes back, then attaches the side channel", async () => {
    const s = setup();
    const core = s.instance();
    const result = await core.start(s.text, s.ticket, s.owner(), OFFER);
    const activeWhenAnswered = s.store.data.get("state") === "active" && s.store.data.get("callId") === "rtc_1";
    expect(result).toMatchObject({ ok: true, answer: "v=0 answer", call: null });
    expect(activeWhenAnswered).toBe(true);
    // No reconnect secret: there is no client link to come back on.
    expect(s.store.data.get("reconnect")).toBeNull();
    expect(s.calls).toMatchObject({ created: 1, attached: 0 });
    await core.attachSide();
    expect(s.calls.attached).toBe(1);
    // The first tick is armed with the active write (row 13).
    expect(s.store.alarm).toBe(s.now() + TICK_MS);
  });

  it("row 8: two offers at once make exactly one call; after active, an offer is refused", async () => {
    let release: (value: { callId: string; answer: string }) => void = () => undefined;
    const s = setup({ createCall: () => new Promise((resolve) => (release = resolve)) });
    const core = s.instance();
    const first = core.start(s.text, s.ticket, s.owner(), OFFER);
    await until(() => s.calls.created === 1);
    expect(await core.start(s.text, s.ticket, s.owner(), OFFER)).toEqual({ ok: false, code: "start_in_flight" });
    release({ callId: "rtc_1", answer: "v=0 answer" });
    expect(await first).toMatchObject({ ok: true });
    expect(await core.start(s.text, s.ticket, s.owner(), OFFER)).toEqual({ ok: false, code: "session_active" });
    // A restarted instance refuses it too: the stored state says active.
    expect(await s.instance().start(s.text, s.ticket, s.owner(), OFFER)).toEqual({ ok: false, code: "session_active" });
    expect(s.calls.created).toBe(1);
  });

  it("rows 10 and 11: a crash once \"connecting\" is stored makes no second call, closes with error and owes no hang-up (no call id)", async () => {
    const s = setup({ createCall: () => never() });
    void s.instance().start(s.text, s.ticket, s.owner(), OFFER);
    await until(() => s.calls.created === 1);
    const restarted = s.instance();
    await restarted.alarm();
    expect(s.calls.created).toBe(1);
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
    expect(s.store.data.get("hangup")).toBeUndefined();
    expect(s.calls.hangups).toEqual([]);
  });

  it("row 12: the provider refuses the call: close with error, nothing to hang up", async () => {
    const s = setup({ createCall: () => Promise.reject(new ProviderRefused(400)) });
    expect(await s.instance().start(s.text, s.ticket, s.owner(), OFFER)).toEqual({ ok: false, code: "provider_unavailable" });
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
    expect(s.calls.hangups).toEqual([]);
  });

  it("row 11: a crash during the active write leaves \"connecting\" and no call id: no second call, and the session ends with error", async () => {
    const s = setup();
    s.store.freezeWhen = (entries) => entries.state === "active";
    void s.instance().start(s.text, s.ticket, s.owner(), OFFER);
    await until(() => s.store.frozen);
    s.store.freezeWhen = null;
    // The app never got the answer, so no media flows; the provider ends the call by itself.
    await s.instance().alarm();
    expect(s.calls.created).toBe(1);
    expect(s.calls.close).toEqual([{ endReason: "error", finalSlice: 0 }]);
  });

  it("row 13: a crash once the call id is stored, whether or not the answer reached the app: a restart reattaches, and never makes a second call", async () => {
    // The answer reached the app: the reattach finds the call, and the session goes on.
    const reached = setup();
    await reached.instance().start(reached.text, reached.ticket, reached.owner(), OFFER);
    reached.tick(TICK_MS);
    await reached.instance().alarm();
    expect(reached.calls).toMatchObject({ created: 1, attached: 1 });
    expect(reached.calls.vault).toEqual([false, true]);
    expect(reached.store.data.get("state")).toBe("active");
    // The tick's checkpoint follows the reattach.
    expect(reached.calls.checkpoints.at(-1)).toMatchObject({ accounting: false, providerCallId: "rtc_1" });

    // It never did: the provider ended the call by itself, so the reattach gets 404, and the session ends.
    const lost = setup({ attach: [404] });
    await lost.instance().start(lost.text, lost.ticket, lost.owner(), OFFER);
    lost.tick(TICK_MS);
    await lost.instance().alarm();
    expect(lost.calls.created).toBe(1);
    expect(lost.calls.close).toEqual([{ endReason: "provider_closed", finalSlice: expect.any(Number) }]);
  });
});

describe("an observed session's side channel (plan section 5; crash table rows 22–24)", () => {
  it("row 22: a restarted instance reattaches with the key from the vault, even after the start ticket expired, and the time since the journal's last write is a gap", async () => {
    const s = setup();
    const first = await started(s);
    await first.recordUsage(usage("t1"), "per_turn");
    s.tick(20_000);
    // The old instance is gone. 40 s later, past the ticket's expiry, the alarm wakes a new one.
    s.tick(40_000);
    expect(s.now()).toBeGreaterThanOrEqual(s.ticket.exp);
    const restarted = s.instance();
    await restarted.alarm();
    // The vault is asked as for a restart: only the seal's own expiry counts then (8j).
    expect(s.calls.vault).toEqual([false, true]);
    expect(s.calls.attached).toBe(2);
    // The usage journaled before the crash counts; the 60 s since its write are a gap, not connection time.
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ slice: { measures: { input_tokens: 100, output_tokens: 20 }, sessionMs: 0, gapMs: 60_000, gaps: 1 } });
  });

  it("row 23: the side channel closes and is attached again at once, with no gap when it is back at once", async () => {
    const s = setup();
    const core = await started(s);
    s.tick(10_000);
    const held = s.calls.attached;
    await s.dropSide();
    expect(s.calls.attached).toBe(held + 1);
    s.tick(50_000);
    await core.recordUsage(usage("t1"), "per_turn");
    await core.checkpoint();
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ slice: { sessionMs: 60_000, gapMs: 0, gaps: 0 } });
  });

  it("503 three times, then it attaches: the call is kept, each tick still checkpoints, and the time without the side channel is one gap", async () => {
    const s = setup({ attach: [101, 503, 503, 503] });
    const core = await started(s);
    s.tick(10_000);
    await s.dropSide();
    for (let tick = 0; tick < 2; tick += 1) {
      s.tick(TICK_MS);
      await core.alarm();
      expect(s.store.data.get("state")).toBe("active");
    }
    expect(s.calls.attached).toBe(4);
    // Each tick that found the side channel down asked the gateway (row 23): a new slice when one
    // was due, an empty checkpoint otherwise.
    expect(s.calls.checkpoints).toHaveLength(2);
    expect(s.calls.checkpoints[1]).toMatchObject({ slice: null, accounting: false });
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.calls.attached).toBe(5);
    expect(s.sides.at(-1)!.closed).toBe(false);
    s.tick(10_000);
    await core.end("client_closed");
    const slices = s.calls.checkpoints.flatMap((seen) => (seen.slice === null ? [] : [seen.slice]));
    // 10 s with the side channel, 90 s without it, 10 s with it again: only the attached time is connection time.
    expect(slices.reduce((sum, slice) => sum + slice.sessionMs, 0)).toBe(20_000);
    expect(slices.reduce((sum, slice) => sum + slice.gapMs, 0)).toBe(90_000);
    expect(s.logs.filter((event) => event.message === "relay_side_channel_unavailable")).toHaveLength(3);
  });

  it("503, then 404: the call ended, so the session ends with provider_closed and owes no hang-up", async () => {
    const s = setup({ attach: [101, 503, 404] });
    const core = await started(s);
    await s.dropSide();
    expect(s.store.data.get("state")).toBe("active");
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.store.data.get("state")).toBe("ended");
    expect(s.calls.close).toEqual([{ endReason: "provider_closed", finalSlice: expect.any(Number) }]);
    expect(s.store.data.get("hangup")).toBeUndefined();
    expect(s.calls.hangups).toEqual([]);
  });

  it("row 24: the vault is down at a restart: each tick tries again and still checkpoints; once it is back, the call is attached", async () => {
    let vaultUp = false;
    const s = setup({ vault: (restart) => (restart && !vaultUp ? Promise.reject(new Error("credential_unavailable")) : Promise.resolve({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" })) });
    await started(s);
    s.tick(TICK_MS);
    const restarted = s.instance();
    await restarted.alarm();
    s.tick(TICK_MS);
    await restarted.alarm();
    expect(s.calls.attached).toBe(1);
    expect(s.store.data.get("state")).toBe("active");
    expect(s.logs.filter((event) => event.message === "relay_vault_refused")).toHaveLength(2);
    vaultUp = true;
    s.tick(TICK_MS);
    await restarted.alarm();
    expect(s.calls.attached).toBe(2);
  });

  it("row 20: empty checkpoints don't count it as connected; once usage came on the side channel, every later one does", async () => {
    const s = setup();
    const core = await started(s);
    await core.checkpoint();
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ connected: false });
    await core.recordUsage(usage("t1"), "per_turn");
    s.tick(60_000);
    await core.checkpoint();
    s.tick(60_000);
    await core.checkpoint();
    expect(s.calls.checkpoints.slice(-2).map((seen) => seen.connected)).toEqual([true, true]);
  });
});

describe("an observed session's end and hang-up (crash table rows 23–25)", () => {
  it("ends at the deadline and hangs the call up with the key it holds", async () => {
    const s = setup();
    const core = await started(s);
    s.tick(30 * 60_000);
    await core.alarm();
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: expect.any(Number) }]);
    expect(s.calls.hangups).toEqual(["rtc_1"]);
    expect(s.store.data.get("hangup")).toBe(false);
    // The side channel was let go too.
    expect(s.sides.at(-1)!.closed).toBe(true);
  });

  it("a detached call still gets an explicit stop at its tick's checkpoint, and is hung up", async () => {
    const s = setup({ attach: [101, 503, 503], checkpoint: async (seen) => ({ decision: seen.accounting ? "continue" : "stop", reasons: seen.accounting ? [] : ["user_blocked"], written: true }) });
    const core = s.instance();
    await core.start(s.text, s.ticket, s.owner(), OFFER);
    await core.attachSide();
    await s.dropSide();
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.calls.close).toEqual([{ endReason: "user_blocked", finalSlice: expect.any(Number) }]);
    expect(s.calls.hangups).toEqual(["rtc_1"]);
  });

  it("a hang-up that fails is tried again on each wakeup, without holding back close; it is given up on, at error, after a while", async () => {
    let up = false;
    const s = setup({ hangup: () => (up ? Promise.resolve() : Promise.reject(new ProviderRefused(500))) });
    const core = await started(s);
    await core.end("budget_stop");
    // close is not held back by the hang-up.
    expect(s.calls.close).toEqual([{ endReason: "budget_stop", finalSlice: expect.any(Number) }]);
    expect(s.store.data.get("hangup")).toBe(true);
    s.tick(CLOSE_RETRY_EVERY_MS);
    await core.alarm();
    expect(s.store.data.get("hangup")).toBe(true);
    // A restarted instance gets the key from the vault for it.
    up = true;
    s.tick(CLOSE_RETRY_EVERY_MS);
    const restarted = s.instance();
    await restarted.alarm();
    expect(s.calls.hangups).toEqual(["rtc_1"]);
    expect(s.calls.vault.at(-1)).toBe(true);
    expect(s.store.data.get("hangup")).not.toBe(true);
    // close went once.
    expect(s.calls.close).toHaveLength(1);

    // A hang-up that keeps failing is tried until the session's seal expires: past close's own
    // retry window, and storage stays meanwhile (crash table row 28).
    let attempts = 0;
    const stuck = setup({ hangup: () => ((attempts += 1), Promise.reject(new ProviderRefused(500))) });
    const other = await started(stuck);
    await other.end("budget_stop");
    stuck.tick(CLOSE_RETRY_MS + CLOSE_RETRY_EVERY_MS);
    await other.alarm();
    expect(stuck.store.data.get("hangup")).toBe(true);
    expect(attempts).toBe(2);
    // The seal expires at the ticket's expiry plus the cap plus the grace. After it the key is
    // never used again, even the one this instance still holds in memory.
    stuck.tick(stuck.ticket.exp + stuck.ticket.cap + SEAL_GRACE_MS - stuck.now());
    await other.alarm();
    expect(attempts).toBe(2);
    expect(stuck.logs).toContainEqual(expect.objectContaining({ level: "error", message: "relay_hangup_given_up" }));
    expect(stuck.logs.some((event) => event.message === "relay_close_given_up")).toBe(false);
    // Nothing is owed any more, and the ticket has long expired: the same wakeup cleans up.
    expect(stuck.store.data.size).toBe(0);
  });
});

describe("an observed session's time and its cap (Sol, #265 round 1)", () => {
  it("keeps the relay's seal grace the same as the gateway's, so the hang-up stops when the vault would refuse", () => {
    expect(SEAL_GRACE_MS).toBe(GATEWAY_SEAL_GRACE_MS);
  });

  it("books no time from before the first side channel; a first attach that fails makes that time a gap", async () => {
    const quick = setup();
    const core = quick.instance();
    await core.start(quick.text, quick.ticket, quick.owner(), OFFER);
    quick.tick(5_000);
    await core.attachSide();
    quick.tick(60_000);
    await core.checkpoint();
    expect(quick.calls.checkpoints.at(-1)).toMatchObject({ slice: { sessionMs: 60_000, gapMs: 0, gaps: 0 } });

    const refused = setup({ attach: [503] });
    const other = refused.instance();
    await other.start(refused.text, refused.ticket, refused.owner(), OFFER);
    refused.tick(5_000);
    await other.attachSide();
    await other.checkpoint();
    refused.tick(TICK_MS);
    await other.alarm();
    refused.tick(60_000);
    await other.checkpoint();
    const slices = refused.calls.checkpoints.flatMap((seen) => (seen.slice === null ? [] : [seen.slice]));
    expect(slices.reduce((sum, slice) => sum + slice.gapMs, 0)).toBe(5_000 + TICK_MS);
    expect(slices.reduce((sum, slice) => sum + slice.sessionMs, 0)).toBe(60_000);
  });

  it("never counts a restart's gap twice: two restarts in a row book only the time the side channel was really down", async () => {
    const s = setup();
    const core = await started(s);
    // A checkpoint now, so none is due at the restarts' ticks: only the attach writes the journal.
    await core.checkpoint();
    s.tick(40_000);
    await s.instance().alarm();
    s.tick(10_000);
    const second = s.instance();
    await second.alarm();
    s.tick(10_000);
    await second.checkpoint();
    const slices = s.calls.checkpoints.flatMap((seen) => (seen.slice === null ? [] : [seen.slice]));
    // Down 40 s before the first restart's attach, then 10 s before the second's.
    expect(slices.reduce((sum, slice) => sum + slice.gapMs, 0)).toBe(50_000);
    expect(slices.reduce((sum, slice) => sum + slice.sessionMs, 0)).toBe(10_000);
  });

  it("an attach waits no longer than the time left; one that comes back past the deadline is let go, and the session ends at the cap", async () => {
    let release: () => void = () => undefined;
    let holding = false;
    const s = setup({ holdAttach: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()) });
    const core = await started(s);
    s.tick(30 * 60_000 - 10_000);
    holding = true;
    const again = s.dropSide();
    await until(() => s.calls.attached === 2);
    expect(s.calls.limits.at(-1)).toBe(10_000);
    // It comes back 4 s past the deadline.
    s.tick(14_000);
    release();
    await again;
    await until(() => s.calls.close.length > 0);
    expect(s.sides.at(-1)!.closed).toBe(true);
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: expect.any(Number) }]);
    expect(s.calls.hangups).toEqual(["rtc_1"]);
    void core;
  });

  it("counts no usage that arrives past the deadline, also in a restarted instance, whose closing wait stops at the deadline too", async () => {
    const waits: number[] = [];
    const s = setup({ turnOpen: () => true, wait: (ms) => (waits.push(ms), Promise.resolve()) });
    await started(s);
    s.tick(30 * 60_000 - 4_000);
    // The old instance is gone; the new one reattaches and learns the deadline from storage.
    const restarted = s.instance();
    await restarted.attachSide();
    await restarted.end("client_closed");
    // The closing wait was cut at the deadline: 4 s, not 10 s.
    expect(waits).toEqual([4_000]);

    const late = setup();
    const core = await started(late);
    late.tick(30 * 60_000);
    await core.recordUsage(usage("after-cap"), "per_turn");
    await core.end("time_cap");
    const slices = late.calls.checkpoints.flatMap((seen) => (seen.slice === null ? [] : [seen.slice]));
    expect(slices.reduce((sum, slice) => sum + (slice.measures.input_tokens ?? 0), 0)).toBe(0);
  });

  it("a side channel that drops while the end waits for an answer leaves the final slice marked as missing usage", async () => {
    const s = setup({ turnOpen: () => true, wait: () => never() });
    const core = await started(s);
    await core.recordUsage(usage("t1"), "per_turn");
    s.tick(5_000);
    const ending = core.end("client_closed");
    await until(() => core.turnWaiter !== null);
    await s.dropSide();
    await ending;
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ accounting: true, slice: { gaps: 1 } });
    expect(s.logs).toContainEqual(expect.objectContaining({ message: "relay_answer_cut" }));
  });
});

describe("an observed session's end against a late attach or a late vault (Sol, #265 round 2)", () => {
  it("an attach that comes back after a stop has ended the session is let go, and recreates nothing, even after cleanup", async () => {
    let release: () => void = () => undefined;
    let holding = false;
    let stop = false;
    const s = setup({
      holdAttach: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
      checkpoint: async (seen) => ({ decision: stop && !seen.accounting ? "stop" : "continue", reasons: stop && !seen.accounting ? ["user_blocked"] : [], written: true }),
    });
    const core = await started(s);
    holding = true;
    void s.dropSide();
    await until(() => s.calls.attached === 2);
    stop = true;
    await core.checkpoint();
    expect(s.calls.close).toEqual([{ endReason: "user_blocked", finalSlice: expect.any(Number) }]);
    expect(core.ending).toBeNull();
    // The ticket expires and the next wakeup cleans up: storage is empty.
    s.tick(s.ticket.exp - s.now());
    await core.alarm();
    expect(s.store.data.size).toBe(0);
    release();
    await until(() => s.sides.length === 2);
    await core.attaching;
    expect(s.sides.at(-1)!.closed).toBe(true);
    expect(s.store.data.size).toBe(0);
    expect(s.calls.close).toHaveLength(1);
  });

  it("extra checkpoints on detached ticks never put off the regular slice: new usage is booked on time", async () => {
    const s = setup({ attach: [101, 503, 503, 503] });
    const core = await started(s);
    await core.checkpoint();
    await core.recordUsage(usage("t1"), "per_turn");
    await s.dropSide();
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ slice: null });
    s.tick(TICK_MS);
    await core.alarm();
    // 60 s since the regular checkpoint: the usage goes in a slice now, detached or not.
    expect(s.calls.checkpoints.at(-1)).toMatchObject({ slice: { measures: { input_tokens: 100 } } });
  });

  it("an attach cut at the cap ends the session with time_cap and hangs up, and so does a vault answer that comes past it", async () => {
    let release: () => void = () => undefined;
    const s = setup({ attach: [101, "throw"], holdAttach: () => (s.calls.attached === 2 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()) });
    await started(s);
    s.tick(30 * 60_000 - 5_000);
    const again = s.dropSide();
    await until(() => s.calls.attached === 2);
    s.tick(5_000);
    release();
    await again;
    await until(() => s.calls.close.length > 0);
    expect(s.calls.close).toEqual([{ endReason: "time_cap", finalSlice: expect.any(Number) }]);
    expect(s.calls.hangups).toEqual(["rtc_1"]);

    let answer: (value: unknown) => void = () => undefined;
    const slow = setup({ vault: (restart) => (restart ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" })) });
    await started(slow);
    slow.tick(30 * 60_000 - 5_000);
    const restarted = slow.instance();
    const attaching = restarted.attachSide();
    await until(() => slow.calls.vault.length === 2);
    slow.tick(5_000);
    answer({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" });
    await attaching;
    await until(() => slow.calls.close.length > 0);
    expect(slow.calls.attached).toBe(1);
    expect(slow.calls.close).toEqual([{ endReason: "time_cap", finalSlice: expect.any(Number) }]);
    expect(slow.calls.hangups).toEqual(["rtc_1"]);
  });

  it("a vault lookup for the hang-up that answers past the seal's expiry sends nothing to the provider", async () => {
    let answer: (value: unknown) => void = () => undefined;
    let hold = false;
    let tries = 0;
    const s = setup({
      hangup: () => ((tries += 1), Promise.reject(new ProviderRefused(500))),
      vault: (restart) => (hold && restart ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" })),
    });
    const core = await started(s);
    await core.end("budget_stop");
    expect(s.store.data.get("hangup")).toBe(true);
    // A restarted instance holds no key: it asks the vault, which answers once the seal has expired.
    hold = true;
    const restarted = s.instance();
    const waking = restarted.alarm();
    await until(() => s.calls.vault.length === 2);
    s.tick(s.ticket.exp + s.ticket.cap + SEAL_GRACE_MS - s.now());
    answer({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" });
    await waking;
    // Only the attempt at the end itself reached the provider.
    expect(tries).toBe(1);
    expect(s.logs).toContainEqual(expect.objectContaining({ level: "error", message: "relay_hangup_given_up" }));
    expect(s.store.data.get("hangup")).not.toBe(true);
  });
});
