/**
 * xAI's voice API through the relay (step 9b; plan 5.2 rule 3, T5 and T20):
 * billed by the relay's own clock from the session's first activity to its
 * close, plus each text message. The session core runs against stand-ins,
 * as in `relay-start.test.ts`; the session object's own reading of frames is
 * checked with a stand-in core.
 */
import { describe, expect, it } from "vitest";
import { adapterFor } from "../relay/src/adapters.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { CLOCK_CHECK_MS, SessionCore } from "../relay/src/start.js";
import { MemoryStore, ticketFor } from "./relay-stand-ins.ts";

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number };

function setup() {
  let now = 1_000_000;
  const store = new MemoryStore();
  const checkpoints: (Slice | null)[] = [];
  const closes: { endReason: string; finalSlice: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const parts = () => ({
    store,
    now: () => now,
    log: (event: Record<string, unknown>) => logs.push(event),
    vault: { sessionKey: async () => ({ key: { value: "xai-key", header: "authorization", format: "Bearer {key}" }, target: "https://api.x.ai/v1/realtime" }) as never },
    main: {
      open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation: "xai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "xai" }) as never,
      checkpoint: async (_ticket: string, input: { slice: Slice | null }) => {
        checkpoints.push(structuredClone(input.slice));
        return { decision: "continue", reasons: [], written: true } as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number }) => {
        closes.push({ endReason: input.endReason, finalSlice: input.finalSlice });
        return { version: 2 };
      },
    },
    provider: { connect: async () => ({ callId: null, close: () => undefined }) },
  });
  const { text, ticket } = ticketFor(now, { providerType: "xai", operation: "xai.realtime", model: "grok-voice-3.0", url: "https://api.x.ai/v1/realtime?model=grok-voice-3.0" });
  const client = { close: () => undefined };
  /** Every slice the session sent: the live ones, then the final delivery's. */
  const slices = () => checkpoints.filter((slice): slice is Slice => slice !== null);
  return { store, checkpoints, closes, logs, slices, text, ticket, client, instance: () => new SessionCore(parts()), tick: (ms: number) => void (now += ms) };
}

describe("an xAI session's clock (step 9b)", () => {
  it("bills nothing for a session with no activity: no slice, no connection time", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    expect(core.idle).toBe(true);
    s.tick(90_000);
    await core.alarm();
    await core.end("client_closed");
    expect(s.slices()).toEqual([]);
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 0 }]);
  });

  it("starts at the first activity, bills to the close, and counts each text message on top", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    s.tick(20_000);
    await core.countText();
    await core.activity();
    expect(core.idle).toBe(false);
    // A second activity changes nothing: the clock started once.
    s.tick(5_000);
    await core.activity();
    await core.countText();
    s.tick(35_000);
    await core.alarm();
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, measures: { text_messages: 2 }, sessionMs: 40_000, gapMs: 0, gaps: 0 })]);
    // The tail after the last answer is billed: the clock runs to the close.
    s.tick(12_000);
    await core.end("client_closed");
    expect(s.slices().at(-1)).toMatchObject({ seq: 2, measures: {}, sessionMs: 12_000, gapMs: 0 });
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 2 }]);
  });

  it("keeps the first activity across a restart: the free time before it stays free, and only the time since the last write is a gap", async () => {
    const s = setup();
    const first = s.instance();
    await first.start(s.text, s.ticket, s.client);
    // The instance that started the session saw the first activity 10 s in, then died 20 s later.
    s.tick(10_000);
    await first.activity();
    s.tick(20_000);
    // The restarted instance: the provider's socket went with the old one, so the session ends.
    await s.instance().alarm();
    expect(s.closes).toEqual([{ endReason: "error", finalSlice: 1 }]);
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, sessionMs: 0, gapMs: 20_000, gaps: 1 })]);
  });

  it("checks xAI's own total against its clock, and logs only a real drift; the total is never billed", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.activity();
    s.tick(16_700);
    // What T20 saw: whole seconds, under a second below the relay's clock.
    await core.recordUsage({ id: "e1", measures: {}, clockSeconds: 16 }, "running_total");
    expect(s.logs.filter((event) => event.message === "relay_clock_mismatch")).toEqual([]);
    s.tick(10_000);
    await core.recordUsage({ id: "e2", measures: {}, clockSeconds: 16 }, "running_total");
    expect(s.logs.filter((event) => event.message === "relay_clock_mismatch")).toEqual([expect.objectContaining({ level: "warn", differenceMs: -10_700 })]);
    expect(10_700).toBeGreaterThan(CLOCK_CHECK_MS);
    s.tick(60_000);
    await core.alarm();
    expect(s.slices()).toEqual([expect.objectContaining({ measures: {}, sessionMs: 86_700 })]);
  });
});

describe("the session object reading xAI's frames (step 9b)", () => {
  /** The session object without its constructor, its core a stand-in that records what it was told. */
  function session() {
    const told: string[] = [];
    const core = {
      idle: true,
      ending: null,
      call: {},
      activity: async () => {
        told.push("activity");
        core.idle = false;
      },
      countText: async () => void told.push("text"),
      recordUsage: async () => void told.push("usage"),
      turnDone: () => void told.push("done"),
    };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const sent: unknown[] = [];
    const live = {
      client: { send: () => undefined },
      deadline: Infinity,
      call: { send: (data: unknown) => sent.push(data) },
      adapter: adapterFor("xai"),
      frames: new SessionFrames({ relayMessages: false }),
      turnOpen: false,
    };
    return { object, live, told, sent };
  }

  it("starts the clock once, on the client's first audio after it went to xAI, and counts each text message", () => {
    const { object, live, told, sent } = session();
    object.toProvider(live as never, JSON.stringify({ type: "session.update", session: {} }));
    object.toProvider(live as never, JSON.stringify({ type: "conversation.item.create", item: { type: "message" } }));
    object.toProvider(live as never, JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    object.toProvider(live as never, JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
    expect(sent).toHaveLength(4);
    expect(told).toEqual(["text", "activity"]);
  });

  it("starts the clock on xAI's first answer too, and a ping is not the provider sending", () => {
    const { object, live, told } = session();
    const before = live.frames.lastProviderAt;
    live.frames.now = () => before + 60_000;
    object.toClient(live as never, '{"type":"ping","event_id":"p1"}');
    expect(live.frames.lastProviderAt).toBe(before);
    object.toClient(live as never, '{"type":"response.created","response":{"id":"r1"}}');
    expect(live.frames.lastProviderAt).toBe(before + 60_000);
    expect(told).toEqual(["activity"]);
  });

  it("an answer that ends in the frame carrying its usage is done only once that usage is written (Fable, #262)", async () => {
    const { object, live, told } = session();
    let written: () => void = () => undefined;
    (object as unknown as { core: { recordUsage: () => Promise<void> } }).core.recordUsage = () =>
      new Promise<void>((resolve) => {
        written = () => {
          told.push("usage written");
          resolve();
        };
      });
    live.adapter = adapterFor("mock_done");
    object.toClient(live as never, JSON.stringify({ type: "response.done", event_id: "e1", usage: { input_tokens: 10, output_tokens: 4 } }));
    await Promise.resolve();
    expect(told).toEqual([]);
    written();
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(told).toEqual(["usage written", "done"]);
  });
});
