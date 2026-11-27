/**
 * GPT-Live through the relay (step 9g; plan, "GPT-Live backend rules", T21).
 * The adapter's reading of GPT-Live's frames, the model and backend lock on
 * the client's frames, and the session core billing the larger of its clock
 * and OpenAI's voice seconds, with each backend call booked under its model.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, backendMeasures } from "../relay/src/adapters.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { SessionCore } from "../relay/src/start.js";
import { MemoryStore, ticketFor } from "./relay-stand-ins.ts";

const GPT_LIVE = adapterFor("gptlive");
const BACKEND = { models: ["gpt-6-luna", "gpt-5.6-luna"], tools: ["function"] };
const meter = () => GPT_LIVE.perCall!("gpt-live-1", { backend: BACKEND });

/** A backend call's usage, as T21 saw it (`gpt-6-luna`, the √144 call). */
const USAGE = {
  input_tokens: 1_093,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_090, cache_write_tokens_details: { ttl_30m_tokens: 1_090, ttl_12h_tokens: 0 } },
  output_tokens: 32,
  output_tokens_details: { reasoning_tokens: 25 },
  total_tokens: 1_125,
};

/** GPT-Live's own events put `event_id` before `type` (T21). */
const usageUpdated = (seconds: number) => JSON.stringify({ event_id: "event_u", type: "session.usage.updated", context_window: { usage_ratio: 0.01 }, usage: { seconds } });
const backendDone = (id: string, model = "gpt-6-luna", type = "response.completed") =>
  JSON.stringify({ event_id: `event_${id}`, type: "response.event", delegation_id: "item_1", event: { type, sequence_number: 17, response: { id, object: "response", status: "completed", model, usage: USAGE } } });
const start = (session: Record<string, unknown>) => JSON.stringify({ type: "session.start", event_id: "start_1", session });
const responses = (fields: Record<string, unknown>) => ({ delegation: { type: "responses", responses: { model: "gpt-6-luna", ...fields } } });

describe("GPT-Live's adapter (step 9g)", () => {
  it("reads a backend call's usage as Responses reports it: the whole input, its cached and written shares, the output", () => {
    expect(backendMeasures(USAGE)).toEqual({ backend_input_tokens: 1_093, backend_cache_write_tokens: 1_090, backend_output_tokens: 32 });
    expect(backendMeasures({ input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10, cache_write_tokens_details: { ttl_12h_tokens: 10 } }, output_tokens: 5 })).toEqual({
      backend_input_tokens: 100,
      backend_cached_tokens: 40,
      backend_cache_write_tokens: 10,
      backend_cache_write_12h_tokens: 10,
      backend_output_tokens: 5,
    });
  });

  it("reads OpenAI's voice seconds, a running total, from session.usage.updated and session.closed, event_id first", () => {
    expect(GPT_LIVE.read(usageUpdated(44))).toEqual({ id: "", measures: {}, audioSeconds: 44 });
    expect(GPT_LIVE.read(JSON.stringify({ event_id: "event_c", type: "session.closed", reason: "close_requested", usage: { seconds: 46 } }))).toEqual({ id: "", measures: {}, audioSeconds: 46 });
    // A figure past a day is nonsense, and the clock bills.
    expect(GPT_LIVE.read(usageUpdated(90_000))).toBeNull();
  });

  it("reads each backend call once it ended, under the model it names and keyed by its response id", () => {
    expect(GPT_LIVE.read(backendDone("resp_1"))).toEqual({ id: "resp_1", model: "gpt-6-luna", measures: backendMeasures(USAGE) });
    expect(GPT_LIVE.read(backendDone("resp_2", "gpt-6-luna", "response.incomplete"))?.id).toBe("resp_2");
    // A malformed model name is booked as unknown, for the sweep.
    expect(GPT_LIVE.read(backendDone("resp_3", "bad model"))?.model).toBe("unknown");
    // A backend call still running, a text delta and an audio delta carry no usage.
    expect(GPT_LIVE.read(backendDone("resp_4", "gpt-6-luna", "response.created"))).toBeNull();
    expect(GPT_LIVE.read(JSON.stringify({ event_id: "e", type: "response.event", event: { type: "response.output_text.delta", delta: '"type":"response.completed"' } }))).toBeNull();
    expect(GPT_LIVE.read(JSON.stringify({ type: "session.output_audio.delta", delta: "A".repeat(6_400) }))).toBeNull();
  });

  it("starts the clock at session.started, where OpenAI's does", () => {
    expect(GPT_LIVE.clock).toBe("first_activity");
    expect(GPT_LIVE.turn(JSON.stringify({ event_id: "e", type: "session.started", session: { model: "gpt-live-1" } }))).toBe("open");
    expect(GPT_LIVE.turn(usageUpdated(14))).toBeNull();
  });
});

describe("the lock on a GPT-Live client's frames (step 9g)", () => {
  it("sets the session's model on session.start, pins the backend's tier to the standard one, and refuses a binary frame or one that isn't JSON", () => {
    expect(meter().lock(new ArrayBuffer(4))).toEqual({ refused: "binary_not_supported" });
    const locked = JSON.parse(meter().lock(start({ model: "gpt-live-2", ...responses({}) })) as string);
    expect(locked.session.model).toBe("gpt-live-1");
    // No tier, or auto, may run at Fast, which OpenAI bills at twice the rate: the standard one is sent (Sol, #272 round 2).
    expect(locked.session.delegation.responses.service_tier).toBe("default");
    expect(JSON.parse(meter().lock(start(responses({ service_tier: "auto" }))) as string).session.delegation.responses.service_tier).toBe("default");
    // A frame that had to be read whole and isn't a JSON object never goes on (Fable, #272).
    expect(meter().lock('{"type":"session.update","session":')).toEqual({ refused: "invalid_frame" });
    expect(meter().lock("[1,2]")).toEqual({ refused: "invalid_frame" });
  });

  it("lets the backend name only a model the app may call, named at the start, and function tools only", () => {
    expect(meter().lock(start({ model: "gpt-live-1" }))).not.toHaveProperty("refused");
    expect(meter().lock(start({ delegation: null }))).not.toHaveProperty("refused");
    expect(meter().lock(start({ delegation: { type: "client" } }))).not.toHaveProperty("refused");
    expect(meter().lock(start(responses({ tools: [{ type: "function", name: "lookup" }] })))).not.toHaveProperty("refused");
    expect(meter().lock(start(responses({ model: "gpt-5.5-pro" })))).toEqual({ refused: "backend_model_not_allowed" });
    expect(meter().lock(start({ delegation: { type: "responses", responses: {} } }))).toEqual({ refused: "backend_model_not_allowed" });
    expect(meter().lock(start(responses({ tools: [{ type: "web_search" }] })))).toEqual({ refused: "backend_tool_not_allowed" });
    expect(meter().lock(start({ delegation: { type: "decisions", decisions: {} } }))).toEqual({ refused: "delegation_not_allowed" });
    // A tier OpenAI bills at another rate is refused: backend calls are booked at the standard rate (Sol, #272 round 1).
    expect(meter().lock(start(responses({ service_tier: "priority" })))).toEqual({ refused: "backend_tier_not_allowed" });
    expect(meter().lock(start(responses({ service_tier: "flex" })))).toEqual({ refused: "backend_tier_not_allowed" });
    expect(meter().lock(start(responses({ service_tier: "auto" })))).not.toHaveProperty("refused");
    expect(meter().lock(start(responses({ service_tier: "default" })))).not.toHaveProperty("refused");
    // Transcript triggers run Decisions, unlocked and unbilled: none (Sol, Fable, #272 round 2). None at all is fine.
    expect(meter().lock(start({ triggers: [{ type: "decision" }] }))).toEqual({ refused: "triggers_not_allowed" });
    expect(meter().lock(start({ triggers: [] }))).not.toHaveProperty("refused");
    expect(meter().lock(start({ triggers: null }))).not.toHaveProperty("refused");
    // A session with no backend allowed: none may be named.
    expect(GPT_LIVE.perCall!("gpt-live-1", {}).lock(start(responses({})))).toEqual({ refused: "backend_model_not_allowed" });
  });

  it("checks every update the same way: a backend model may change only to one allowed, and one left out keeps the one in force", () => {
    const call = meter();
    call.lock(start(responses({})));
    const update = (session: Record<string, unknown>) => JSON.stringify({ type: "session.update", session });
    expect(call.lock(update({ delegation: { type: "responses", responses: { instructions: "Be brief." } } }))).not.toHaveProperty("refused");
    expect(call.lock(update(responses({ model: "gpt-5.6-luna" })))).not.toHaveProperty("refused");
    expect(call.lock(update(responses({ model: "gpt-5.5-pro" })))).toEqual({ refused: "backend_model_not_allowed" });
    expect(call.lock(update(responses({ tools: [{ type: "file_search" }] })))).toEqual({ refused: "backend_tool_not_allowed" });
    expect(call.lock(update({ triggers: [{ type: "decision" }] }))).toEqual({ refused: "triggers_not_allowed" });
    // An update's auto tier is pinned to the standard one; one that names none keeps the one the start set.
    expect(JSON.parse(call.lock(update({ delegation: { type: "responses", responses: { service_tier: "auto" } } })) as string).session.delegation.responses.service_tier).toBe("default");
    expect(JSON.parse(call.lock(update({ delegation: { type: "responses", responses: { instructions: "Hi." } } })) as string).session.delegation.responses).not.toHaveProperty("service_tier");
  });

  it("never parses an audio append", () => {
    const append = JSON.stringify({ type: "session.input_audio.append", audio: "A".repeat(3_200) });
    expect(meter().lock(append)).toBe(append);
  });
});

describe("a GPT-Live call's backend calls in progress (Sol, #272 round 1)", () => {
  const created = (id: string) => JSON.stringify({ event_id: `event_c_${id}`, type: "response.event", delegation_id: "item_1", event: { type: "response.created", response: { id, model: "gpt-6-luna" } } });

  it("waits for a backend call from its start until its usage is written, and one still running is unfinished", () => {
    const call = meter();
    expect(call.pending()).toBe(false);
    expect(call.see(created("resp_1"), true)).toBeNull();
    expect(call.pending()).toBe(true);
    expect(call.unfinished()).toBe(true);
    expect(call.see(backendDone("resp_1"), true)).toBe("resp_1");
    // Ended, its usage still being written: waited for, but not cut.
    expect(call.pending()).toBe(true);
    expect(call.unfinished()).toBe(false);
    call.settled("resp_1");
    expect(call.pending()).toBe(false);
    // Audio is never looked at.
    expect(call.see(JSON.stringify({ type: "session.output_audio.delta", delta: "A".repeat(6_400) }), true)).toBeNull();
  });

});

describe("the session object with a GPT-Live call (step 9g)", () => {
  function setup() {
    const ended: unknown[] = [];
    const logs: unknown[] = [];
    const core = { idle: false, ending: null, call: {}, sessionId: "ses_1", log: (event: unknown) => logs.push(event) };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    (object as unknown as { endFor: unknown }).endFor = (_live: unknown, reason: string, code: number, closeReason: string) => ended.push([reason, code, closeReason]);
    const sent: unknown[] = [];
    const call = { send: (data: unknown) => sent.push(data), meter: meter() };
    const live = { client: { send: () => undefined }, deadline: Infinity, call, adapter: GPT_LIVE, frames: new SessionFrames({ relayMessages: false }), turnOpen: false, turns: 0 };
    (object as unknown as { live: unknown }).live = live;
    return { object, live, sent, ended, logs };
  }

  it("sends the locked session.start, and ends the session with 1008 on a frame the lock refuses, sending it nowhere", () => {
    const { object, live, sent, ended } = setup();
    object.toProvider(live as never, start({ model: "gpt-live-2", ...responses({}) }));
    expect(JSON.parse(sent[0] as string).session.model).toBe("gpt-live-1");
    object.toProvider(live as never, JSON.stringify({ type: "session.update", session: responses({ model: "gpt-5.5-pro" }) }));
    expect(sent).toHaveLength(1);
    expect(ended).toEqual([["error", 1008, "backend_model_not_allowed"]]);
  });
});

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number; billedMs?: number; transcriptions?: Record<string, Record<string, number>> };

describe("a GPT-Live session's billing (step 9g)", () => {
  function setup() {
    let now = 1_000_000;
    const store = new MemoryStore();
    const checkpoints: (Slice | null)[] = [];
    const closes: { endReason: string; finalSlice: number }[] = [];
    const parts = () => ({
      store,
      now: () => now,
      log: () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/live/sessions" }) as never },
      main: {
        open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation: "openai.live", checkpointIntervalMs: 60_000, version: 2, adapter: "gptlive", model: "gpt-live-1", backend: BACKEND }) as never,
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
    const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.live", model: "gpt-live-1", url: "https://api.openai.com/v1/live/sessions" });
    const slices = () => checkpoints.filter((slice): slice is Slice => slice !== null);
    return { closes, slices, text, ticket, parts, client: { close: () => undefined }, instance: () => new SessionCore(parts()), tick: (ms: number) => void (now += ms) };
  }

  it("bills the larger of its clock from session.started and OpenAI's seconds, and each backend call under its own model", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    // Free until session.started, as OpenAI's own clock.
    s.tick(1_000);
    await core.activity();
    s.tick(15_000);
    await core.recordUsage(GPT_LIVE.read(usageUpdated(14))!, GPT_LIVE.shape);
    await core.recordUsage(GPT_LIVE.read(backendDone("resp_1"))!, GPT_LIVE.shape);
    // A repeated event is booked once.
    await core.recordUsage(GPT_LIVE.read(backendDone("resp_1"))!, GPT_LIVE.shape);
    // The relay ends it 4 s past the last usage update: no session.closed, so the clock bills the tail.
    s.tick(4_000);
    await core.end("client_closed");
    expect(s.slices()).toEqual([
      expect.objectContaining({ sessionMs: 19_000, billedMs: 19_000, transcriptions: { "gpt-6-luna": backendMeasures(USAGE) } }),
    ]);
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 1 }]);
  });

  it("a backend call its end cuts marks the final slice partial, with no estimate (Sol, #272 round 1)", async () => {
    const s = setup();
    const call = meter();
    call.see(JSON.stringify({ event_id: "e", type: "response.event", event: { type: "response.created", response: { id: "resp_9" } } }), true);
    const core = new SessionCore({ ...s.parts(), unfinished: () => call.unfinished(), turnOpen: () => call.pending() });
    await core.start(s.text, s.ticket, s.client);
    await core.activity();
    s.tick(10_000);
    await core.end("time_cap");
    expect(s.slices()).toEqual([expect.objectContaining({ sessionMs: 10_000, gaps: 1 })]);
  });

  it("bills OpenAI's seconds when they run past the clock", async () => {
    const s = setup();
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.activity();
    s.tick(10_000);
    await core.recordUsage({ id: "", measures: {}, audioSeconds: 12 }, GPT_LIVE.shape);
    await core.end("client_closed");
    expect(s.slices()).toEqual([expect.objectContaining({ sessionMs: 10_000, billedMs: 12_000 })]);
  });

  it("a restart ends the session: the time since the journal's last durable write is an unknown-cost gap", async () => {
    const s = setup();
    const first = s.instance();
    await first.start(s.text, s.ticket, s.client);
    await first.activity();
    s.tick(15_000);
    await first.recordUsage({ id: "", measures: {}, audioSeconds: 15 }, GPT_LIVE.shape);
    // The object dies 12 s later: OpenAI drops the session, and it can't be rejoined.
    s.tick(12_000);
    await s.instance().alarm();
    expect(s.closes).toEqual([{ endReason: "error", finalSlice: 1 }]);
    expect(s.slices()).toEqual([expect.objectContaining({ sessionMs: 15_000, gapMs: 12_000, gaps: 1, billedMs: 15_000 })]);
  });
});
