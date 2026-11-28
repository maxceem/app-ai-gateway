/**
 * OpenAI's observed calls in the relay (plan step 12, part 12a; plan section 5): the side channel's
 * keepalive, the 3-minute idle rule, the call's form with the model locked, and OpenAI's events read from
 * the side channel. The session's life (reattach on close, 503 and 404, restarts, hang-up) is the mock's,
 * in `relay-observed.test.ts`; the real runtime is in `relay-session.test.ts`. The clock is the test's.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, openAiMeasures } from "../relay/src/adapters.js";
import { TICK_MS } from "../relay/src/frames.js";
import { Session } from "../relay/src/index.js";
import { callForm } from "../relay/src/provider.js";
import { ProviderRefused, SIDE_IDLE_MS, SIDE_KEEPALIVE_MS, SessionCore } from "../relay/src/start.js";
import { MemoryStore, ticketFor } from "./relay-stand-ins.ts";

const OPENAI = adapterFor("openai");
const OFFER = { sdp: "v=0\r\n", session: {} };
const KEY = { key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime/calls" };
type Seen = { slice: { measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number } | null; accounting: boolean };

/** An observed OpenAI session in the core, its side channels with a keepalive, as OpenAI's are. */
function setup(attachAnswers: (101 | 404 | 503)[] = []) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const answers = [...attachAnswers];
  const sides: { closed: boolean; keepalives: number; close: () => void; keepalive: () => void; callId: string }[] = [];
  const checkpoints: Seen[] = [];
  const closes: string[] = [];
  const hangups: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let core: SessionCore | null = null;
  const instance = () =>
    (core = new SessionCore({
      store,
      now: () => now,
      log: (event) => logs.push(event),
      vault: { sessionKey: async () => KEY },
      main: {
        open: async () => ({ deadline: now + 30 * 60_000, mode: "observed", operation: "openai.realtime.calls", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime" }),
        checkpoint: async (_ticket, input) => (checkpoints.push(structuredClone(input) as Seen), { decision: "continue", reasons: [], written: true }),
        close: async (_ticket, input) => (closes.push(input.endReason), { version: 2 }),
      },
      provider: {
        connect: async () => {
          throw new Error("never relayed");
        },
        createCall: async () => ({ callId: "rtc_1", answer: "v=0 answer" }),
        attach: async (_key, callId) => {
          const answer = answers.shift() ?? 101;
          if (answer !== 101) throw new ProviderRefused(answer);
          const side = {
            closed: false,
            keepalives: 0,
            callId,
            close: () => void (side.closed = true),
            keepalive: () => void (side.keepalives += 1),
          };
          sides.push(side);
          return side;
        },
        hangup: async (_key, callId) => void hangups.push(callId),
      },
    }));
  const { text, ticket } = ticketFor(now, { mode: "observed", operation: "openai.realtime.calls", url: KEY.target });
  return {
    store,
    sides,
    checkpoints,
    closes,
    hangups,
    logs,
    instance,
    core: () => core!,
    async started() {
      const started = instance();
      expect(await started.start(text, ticket, { close: () => undefined }, OFFER)).toMatchObject({ ok: true });
      await started.attachSide();
      return started;
    },
    tick: (ms: number) => void (now += ms),
    now: () => now,
  };
}

const slices = (seen: Seen[]) => seen.flatMap((one) => (one.slice === null ? [] : [one.slice]));

describe("the side channel's keepalive (plan section 5; T9, T21, T22)", () => {
  it("is sent as soon as the side channel attaches, then on the first tick a minute after the last one", async () => {
    const s = setup();
    const core = await s.started();
    expect(s.sides[0]!.keepalives).toBe(1);
    // OpenAI answers each keepalive: the side channel is heard.
    for (const expected of [1, 2, 2, 3]) {
      s.tick(TICK_MS);
      core.heard();
      await core.alarm();
      expect(s.sides[0]!.keepalives).toBe(expected);
    }
    expect(s.sides).toHaveLength(1);
  });

  it("is sent once by each new side channel, also after a restart", async () => {
    const s = setup();
    await s.started();
    s.tick(TICK_MS);
    const restarted = s.instance();
    await restarted.alarm();
    expect(s.sides.map((side) => side.keepalives)).toEqual([1, 1]);
  });
});

describe("the idle rule (plan section 5; T18)", () => {
  it("a side channel heard from every minute is kept for the whole session", async () => {
    const s = setup();
    const core = await s.started();
    for (let tick = 0; tick < 20; tick += 1) {
      s.tick(TICK_MS);
      if (tick % 2 === 1) core.heard();
      await core.alarm();
    }
    expect(s.sides).toHaveLength(1);
    expect(s.logs.some((event) => event.message === "relay_side_channel_idle")).toBe(false);
  });

  it("one that brought nothing for 3 minutes is let go and attached again on the same tick; the time since it was last heard, in the slice not yet sent, is a gap", async () => {
    const s = setup();
    const core = await s.started();
    s.tick(20_000);
    core.heard();
    await core.checkpoint();
    // Nothing more for 3 minutes, though the keepalive went every minute.
    for (let elapsed = 0; elapsed < SIDE_IDLE_MS; elapsed += TICK_MS) {
      s.tick(TICK_MS);
      await core.alarm();
    }
    expect(s.sides).toHaveLength(2);
    expect(s.sides[0]!.closed).toBe(true);
    expect(s.sides[1]!.closed).toBe(false);
    expect(s.sides[1]!.keepalives).toBe(1);
    expect(s.logs).toContainEqual(expect.objectContaining({ level: "warn", message: "relay_side_channel_idle" }));
    s.tick(10_000);
    await core.checkpoint();
    // Heard at 20 s; the minute checkpoints at 80 s and 140 s were sent before the silence was known, and
    // stay as booked. The slice from 140 s to the reattach at 200 s is a gap, so it is partial: the customer
    // sees that the session may have missed usage. Then 10 s with the new side channel.
    const booked = slices(s.checkpoints);
    expect(booked.reduce((sum, slice) => sum + slice.sessionMs, 0)).toBe(150_000);
    expect(booked.reduce((sum, slice) => sum + slice.gapMs, 0)).toBe(60_000);
    expect(booked.at(-2)).toMatchObject({ sessionMs: 0, gapMs: 60_000, gaps: 1 });
    expect(s.store.data.get("state")).toBe("active");
  });

  it("follows the reattach rules: a 503 keeps the call for the next tick, and a 404 ends it with provider_closed and no hang-up", async () => {
    const s = setup([101, 503, 404]);
    const core = await s.started();
    s.tick(SIDE_IDLE_MS);
    await core.alarm();
    expect(s.store.data.get("state")).toBe("active");
    expect(s.sides[0]!.closed).toBe(true);
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.closes).toEqual(["provider_closed"]);
    expect(s.hangups).toEqual([]);
  });
});

describe("billing while detached (plan step 12: no plan minutes and no clock charges; the slot held)", () => {
  it("a call whose side channel stays down for 10 minutes books no connection time then, only a gap, and stays active until a 404", async () => {
    // The reattach at the close gets the first 503, then each of 20 ticks one more; the 21st tick gets the 404.
    const s = setup([101, ...Array<503>(21).fill(503), 404]);
    const core = await s.started();
    s.tick(30_000);
    core.heard();
    s.sides[0]!.closed = true;
    await core.sideGone(s.sides[0] as never);
    for (let tick = 0; tick < 20; tick += 1) {
      s.tick(TICK_MS);
      await core.alarm();
      // The slot is held: the session runs on, and every detached tick asks the gateway.
      expect(s.store.data.get("state")).toBe("active");
    }
    s.tick(TICK_MS);
    await core.alarm();
    expect(s.closes).toEqual(["provider_closed"]);
    const booked = slices(s.checkpoints);
    expect(booked.reduce((sum, slice) => sum + slice.sessionMs, 0)).toBe(30_000);
    expect(booked.reduce((sum, slice) => sum + slice.gapMs, 0)).toBe(21 * TICK_MS);
    expect(booked.filter((slice) => slice.gapMs > 0).every((slice) => slice.gaps > 0)).toBe(true);
  });
});

describe("the call's form (plan 5.1: only the model is locked)", () => {
  const sent = async (offer: { sdp: string; session: Record<string, unknown> }) => {
    const form = callForm(offer, "gpt-realtime-2.1-mini");
    return { sdp: form.get("sdp"), session: JSON.parse(String(form.get("session"))) as Record<string, unknown> };
  };

  it("names the session's model and a realtime session, whatever the app's session says, and keeps the rest as it is", async () => {
    expect(await sent({ sdp: "v=0\r\n", session: {} })).toEqual({ sdp: "v=0\r\n", session: { type: "realtime", model: "gpt-realtime-2.1-mini" } });
    const app = { type: "transcription", model: "gpt-realtime-2.1", instructions: "Be brief.", audio: { output: { voice: "marin" } } };
    expect(await sent({ sdp: "v=0\r\n", session: app })).toEqual({
      sdp: "v=0\r\n",
      session: { type: "realtime", model: "gpt-realtime-2.1-mini", instructions: "Be brief.", audio: { output: { voice: "marin" } } },
    });
  });

  it("writes the session again from what was parsed, so a repeated model key can't read differently at OpenAI", async () => {
    // The relay parsed the app's text whole (JSON.parse keeps the last of a repeated key); the form is written from that.
    const parsed = JSON.parse('{"model":"gpt-realtime-2.1","model":"gpt-realtime-2.1"}') as Record<string, unknown>;
    const form = callForm({ sdp: "v=0", session: parsed }, "gpt-realtime-2.1-mini");
    expect(String(form.get("session")).match(/"model"/gu)).toHaveLength(1);
  });
});

describe("OpenAI's events on the side channel (the session object, step 12)", () => {
  /** The session object without its constructor, its core a stand-in that records the usage it was given. */
  function sideSetup() {
    const recorded: unknown[] = [];
    const logs: Record<string, unknown>[] = [];
    let heard = 0;
    const side = { callId: "rtc_1" };
    const core = {
      call: side,
      sessionId: "ses_1",
      heard: () => void (heard += 1),
      log: (event: Record<string, unknown>) => logs.push(event),
      recordUsage: async (event: unknown, _shape: unknown, written?: () => void) => {
        recorded.push(event);
        written?.();
      },
      turnDone: () => undefined,
    };
    const object = Object.create(Session.prototype) as Session;
    Object.assign(object, { core, live: null });
    const meter = OPENAI.perCall!("gpt-realtime-2.1");
    (object as unknown as { sideMeter: unknown }).sideMeter = meter;
    const frame = (data: Record<string, unknown>) => object.sideFrame(side as never, OPENAI, meter, JSON.stringify(data));
    return { object, meter, frame, recorded, logs, heard: () => heard };
  }
  const updated = (session: Record<string, unknown>) => ({ type: "session.updated", event_id: `event_${crypto.randomUUID().slice(0, 6)}`, session: { type: "realtime", model: "gpt-realtime-2.1", ...session } });
  const transcribed = (id: string) => ({ type: "conversation.item.input_audio_transcription.completed", event_id: id, item_id: id, usage: { type: "tokens", input_tokens: 30, output_tokens: 4 } });

  it("reads an answer's usage and tracks it as open until its response.done, and every frame keeps the side channel heard", async () => {
    const { frame, meter, recorded, heard } = sideSetup();
    frame({ type: "response.created", event_id: "e1", response: { id: "resp_1" } });
    expect(meter.pending()).toBe(true);
    const usage = { input_tokens: 120, output_tokens: 40, input_token_details: { text_tokens: 120 }, output_token_details: { audio_tokens: 40 } };
    frame({ type: "response.done", event_id: "e2", response: { id: "resp_1", usage } });
    await Promise.resolve();
    expect(recorded).toEqual([{ id: "resp_1", measures: openAiMeasures(usage) }]);
    expect(meter.pending()).toBe(false);
    expect(heard()).toBe(2);
  });

  it("a keepalive echo that arrives while the app's own session.update is pending changes nothing: the latest session.updated is the session", async () => {
    // The app asks, on its own data channel, for another transcription model. The relay's keepalive went first,
    // so its echo still states the old settings, and the app's answer comes after it.
    const first = sideSetup();
    first.frame(updated({ audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } }));
    first.frame(updated({ audio: { input: { transcription: { model: "gpt-4o-transcribe" } } } }));
    first.frame(transcribed("item_1"));
    // The other way round: OpenAI applied the app's update first, and the echo states the new settings again.
    const second = sideSetup();
    second.frame(updated({ audio: { input: { transcription: { model: "gpt-4o-transcribe" } } } }));
    second.frame(updated({ audio: { input: { transcription: { model: "gpt-4o-transcribe" } } } }));
    second.frame(transcribed("item_1"));
    await Promise.resolve();
    for (const one of [first, second]) {
      expect(one.recorded).toEqual([{ id: "item_1", measures: { transcription_input_tokens: 30, transcription_output_tokens: 4 }, model: "gpt-4o-transcribe" }]);
      // An echo opens no answer and nothing waits for it.
      expect(one.meter.pending()).toBe(false);
      expect(one.logs).toEqual([]);
    }
  });
});

describe("the keepalive's shape (T9)", () => {
  it("is a session.update with only the session's type, which creates nothing and bills nothing", () => {
    expect(JSON.parse(OPENAI.sideKeepalive!)).toEqual({ type: "session.update", session: { type: "realtime" } });
    expect(SIDE_KEEPALIVE_MS).toBe(60_000);
  });
});

describe("OpenAI's answers and transcriptions across a reattach or a settings change (Sol, #277 round 1)", () => {
  const created = (id: string) => JSON.stringify({ type: "response.created", event_id: `event_c_${id}`, response: { id } });
  const doneOf = (id: string) => JSON.stringify({ type: "response.done", event_id: `event_d_${id}`, response: { id, usage: { input_tokens: 50, output_tokens: 10 } } });
  const updated = (model: string) => JSON.stringify({ type: "session.updated", event_id: "event_s", session: { type: "realtime", audio: { input: { transcription: { model } } } } });
  const committed = (item: string) => JSON.stringify({ type: "input_audio_buffer.committed", event_id: `event_k_${item}`, item_id: item });
  const completedFor = (item: string) =>
    JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: `event_t_${item}`, item_id: item, usage: { type: "tokens", input_tokens: 30, output_tokens: 4 } });
  /** What the session object does with a frame: the meter sees it, then its usage is read and labelled. */
  const through = (meter: NonNullable<ReturnType<NonNullable<typeof OPENAI.perCall>>>, data: string) => {
    meter.see(data, true);
    const read = OPENAI.read(data);
    return read === null ? null : meter.label(read);
  };

  it("an answer that started before a reattach and finishes after a newer one started closes only itself, and is still billed", () => {
    // The new side channel's meter never saw answer A start.
    const meter = OPENAI.perCall!("gpt-realtime-2.1");
    through(meter, created("resp_B"));
    const billedA = through(meter, doneOf("resp_A"));
    expect(billedA).toMatchObject({ id: "resp_A", measures: { input_tokens: 50, output_tokens: 10 } });
    // B is still open: a stop now waits for it, and an end now would mark it cut.
    expect(meter.unfinished()).toBe(true);
    through(meter, doneOf("resp_B"));
    expect(meter.unfinished()).toBe(false);
  });

  it("two answers open at once on a relayed call each close by their own id, in either order (#270 still holds)", () => {
    const meter = OPENAI.perCall!("gpt-realtime-2.1");
    through(meter, created("resp_1"));
    through(meter, created("resp_2"));
    through(meter, doneOf("resp_2"));
    expect(meter.unfinished()).toBe(true);
    through(meter, doneOf("resp_1"));
    expect(meter.unfinished()).toBe(false);
    // A repeated done for an answer already closed changes nothing.
    through(meter, doneOf("resp_1"));
    expect(meter.unfinished()).toBe(false);
  });

  it("an audio delta is never parsed: only its length counts toward the estimate while an answer is open", () => {
    const meter = OPENAI.perCall!("gpt-realtime-2.1");
    through(meter, created("resp_1"));
    // Not JSON past its type: a parse would fail, a length read doesn't.
    meter.see('{"type":"response.output_audio.delta","delta":"' + "A".repeat(3_200) + "<not json", true);
    expect(meter.estimate()).toMatchObject({ measures: { output_tokens: 2, estimated_tokens: 2 } });
  });

  it("a transcription is billed at the model of the moment its item was committed, even if a session.update changed it before it completed", () => {
    const meter = OPENAI.perCall!("gpt-realtime-2.1");
    through(meter, updated("gpt-4o-mini-transcribe"));
    through(meter, committed("item_1"));
    through(meter, updated("gpt-4o-transcribe"));
    through(meter, committed("item_2"));
    expect(through(meter, completedFor("item_1"))).toMatchObject({ model: "gpt-4o-mini-transcribe" });
    expect(through(meter, completedFor("item_2"))).toMatchObject({ model: "gpt-4o-transcribe" });
    // An item the relay never saw committed (before a reattach): the session's model now.
    expect(through(meter, completedFor("item_0"))).toMatchObject({ model: "gpt-4o-transcribe" });
    expect(meter.unfinished()).toBe(false);
  });
});
