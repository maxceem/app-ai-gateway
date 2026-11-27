/**
 * OpenAI Realtime over WebSocket through the relay (step 9e; plan, the
 * provider table: tokens per answer, plus input transcription billed apart).
 * The adapter's reading of OpenAI's frames (T8, T9, T21 shapes), the call's
 * memory (its audio format, its transcription model, the answer in progress),
 * the model lock, and the session core's estimate for an answer its own end cuts.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, openAiMeasures, transcriptionMeasures } from "../relay/src/adapters.js";
import { carryOpen, freeze, newJournal, addUsage } from "../relay/src/journal.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { END_WRITES_MS, SessionCore } from "../relay/src/start.js";
import { MemoryStore, never, ticketFor, until } from "./relay-stand-ins.ts";

const OPENAI = adapterFor("openai");
const meter = (model: string | null = "gpt-realtime-2.1") => OPENAI.perCall!(model);

/** `response.done` as OpenAI sends it (T21's shape), with `usage` inside `response`. */
function done(id: string, usage: Record<string, unknown>) {
  return JSON.stringify({ type: "response.done", event_id: `event_${id}`, response: { object: "realtime.response", id, status: "completed", usage } });
}

/** An answer's usage on `gpt-realtime-2.1`: a spoken question and a spoken answer, part of the prompt cached. */
const USAGE = {
  total_tokens: 1_520,
  input_tokens: 1_200,
  output_tokens: 320,
  input_token_details: {
    text_tokens: 700,
    audio_tokens: 480,
    image_tokens: 20,
    cached_tokens: 600,
    cached_tokens_details: { text_tokens: 400, audio_tokens: 190, image_tokens: 10 },
  },
  output_token_details: { text_tokens: 60, audio_tokens: 260 },
};

const session = (fields: Record<string, unknown>) => JSON.stringify({ type: "session.updated", event_id: "event_s", session: { type: "realtime", model: "gpt-realtime-2.1", ...fields } });
const delta = (chars: number) => JSON.stringify({ type: "response.output_audio.delta", event_id: "event_d", response_id: "resp_1", delta: "A".repeat(chars) });

describe("OpenAI Realtime's adapter (step 9e)", () => {
  it("reads an answer's usage from response.done: cached at the cached rate, audio whole with its cached share apart, a cached image as uncached", () => {
    expect(openAiMeasures(USAGE)).toEqual({
      // 600 cached, of which 10 image tokens bill as uncached: 590 at the cached rate.
      input_tokens: 610,
      cached_input_tokens: 590,
      input_split: 1,
      input_audio_tokens: 480,
      input_image_tokens: 20,
      cached_input_audio_tokens: 190,
      output_tokens: 320,
      output_split: 1,
      output_audio_tokens: 260,
    });
  });

  it("applies the cache discount only where the cached modality is known: unexplained cached tokens bill as unknown, an estimate (Sol, #270 round 4)", () => {
    // 1,000 input tokens, 800 of them audio, 600 cached with no split by modality.
    const usage = { input_tokens: 1_000, output_tokens: 0, input_token_details: { text_tokens: 200, audio_tokens: 800, cached_tokens: 600 } };
    expect(openAiMeasures(usage)).toMatchObject({ input_tokens: 1_000, input_unknown_tokens: 600, input_audio_tokens: 800, estimated_tokens: 600 });
    expect(openAiMeasures(usage)).not.toHaveProperty("cached_input_tokens");
  });

  it("records tokens no breakdown covers as unknown, so they bill at the highest rate even beside an answer that was broken down (Sol, #270 round 1)", () => {
    // No breakdown at all: every token is unknown.
    expect(openAiMeasures({ input_tokens: 50, output_tokens: 7 })).toEqual({ input_tokens: 50, input_split: 1, input_unknown_tokens: 50, output_tokens: 7, output_split: 1, output_unknown_tokens: 7 });
    // A breakdown that covers only part: the rest is unknown.
    expect(openAiMeasures({ input_tokens: 100, output_tokens: 10, input_token_details: { text_tokens: 60 }, output_token_details: { audio_tokens: 4 } })).toMatchObject({
      input_unknown_tokens: 40,
      output_audio_tokens: 4,
      output_unknown_tokens: 6,
    });
    // Two answers in one slice, one broken down and one not: the second's tokens stay unknown, never text.
    const journal = newJournal(0);
    addUsage(journal, { id: "r1", measures: openAiMeasures(USAGE) }, "per_turn", 1);
    addUsage(journal, { id: "r2", measures: openAiMeasures({ input_tokens: 50, output_tokens: 7 }) }, "per_turn", 2);
    expect(freeze(journal, 3)?.measures).toMatchObject({ input_tokens: 660, input_unknown_tokens: 50, output_tokens: 327, output_unknown_tokens: 7, output_audio_tokens: 260 });
  });

  it("reads the usage inside the frame that ends the answer, keyed by the response's id, and parses no audio delta", () => {
    const event = OPENAI.read(done("resp_1", USAGE));
    expect(event).toEqual({ id: "resp_1", measures: openAiMeasures(USAGE) });
    // The call's meter, not the adapter, tells a closing session what is open.
    expect(OPENAI.turn(done("resp_1", USAGE))).toBeNull();
    // An audio delta is never read for usage: its type is read from the frame's start.
    expect(OPENAI.read(delta(64_000))).toBeNull();
    // response.done without usage reads as nothing.
    expect(OPENAI.read(JSON.stringify({ type: "response.done", response: { id: "r" } }))).toBeNull();
  });

  it("reads an input transcription's usage as measures of its own: tokens, or the audio's length", () => {
    const tokens = { type: "tokens", total_tokens: 70, input_tokens: 60, input_token_details: { text_tokens: 5, audio_tokens: 55 }, output_tokens: 10 };
    expect(transcriptionMeasures(tokens)).toEqual({ transcription_input_tokens: 60, transcription_input_audio_tokens: 55, transcription_output_tokens: 10 });
    expect(transcriptionMeasures({ type: "duration", seconds: 3.2 })).toEqual({ transcription_audio_ms: 3_200 });
    const frame = JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "event_t1", item_id: "item_1", transcript: "hello", usage: tokens });
    expect(OPENAI.read(frame)).toEqual({ id: "event_t1", measures: transcriptionMeasures(tokens) });
    // A transcription with no usage reads as nothing.
    expect(OPENAI.read(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "e", transcript: "hi" }))).toBeNull();
  });
});

describe("an OpenAI call's memory (step 9e)", () => {
  it("names a transcription's model from OpenAI's own session.updated; the session's own usage keeps none", () => {
    const call = meter();
    const transcription = { id: "t1", measures: { transcription_input_tokens: 10 } };
    // Before OpenAI said which model transcribes, the event is `unknown`: booked unresolved, never free.
    expect(call.label(transcription)).toEqual({ ...transcription, model: "unknown" });
    call.see(session({ audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } }, output: { format: { type: "audio/pcm", rate: 24_000 } } } }), true);
    expect(call.label(transcription)).toEqual({ ...transcription, model: "gpt-4o-mini-transcribe" });
    expect(call.label({ id: "r1", measures: { input_tokens: 5 } })).toEqual({ id: "r1", measures: { input_tokens: 5 } });
    // The older spelling too.
    const beta = meter();
    beta.see(JSON.stringify({ type: "session.created", session: { input_audio_transcription: { model: "whisper-1" } } }), true);
    expect(beta.label(transcription)).toMatchObject({ model: "whisper-1" });
  });

  it("estimates an answer the session's own end cuts from the audio forwarded, at 20 tokens a second, and never an answer that is done", () => {
    const call = meter();
    expect(call.estimate()).toBeNull();
    call.see('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}', true);
    // Two seconds of 24 kHz PCM in base64 (64,000 characters a second) reached the client.
    call.see(delta(64_000), true);
    call.see(delta(64_000), true);
    // Audio thrown away while the session closes is not billed.
    call.see(delta(64_000), false);
    const cut = call.estimate();
    expect(cut?.measures).toEqual({ output_tokens: 41, output_split: 1, output_audio_tokens: 41, estimated_tokens: 41 });
    // Asked once: the answer is over.
    expect(call.estimate()).toBeNull();
    // An answer that finished is billed by its own usage, never estimated.
    call.see('{"type":"response.created","event_id":"e2","response":{"id":"resp_2"}}', true);
    call.see(delta(64_000), true);
    call.see(done("resp_2", USAGE), true);
    expect(call.estimate()).toBeNull();
  });

  it("estimates G.711 audio at its own rate: a second is far fewer characters, so the guess is never low", () => {
    const call = meter();
    call.see(session({ audio: { output: { format: { type: "audio/pcmu" } } } }), true);
    call.see('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}', true);
    call.see(delta(10_667), true);
    expect(call.estimate()?.measures.output_audio_tokens).toBe(Math.ceil((delta(10_667).length) / 533));
  });

  it("locks the model: a client's session.update may not move the session to another, and anything else goes as it is", () => {
    const call = meter("gpt-realtime-2.1");
    const moved = JSON.parse(call.lock(JSON.stringify({ type: "session.update", session: { type: "realtime", model: "gpt-realtime-2.1-mini", instructions: "Hi" } })) as string);
    expect(moved).toEqual({ type: "session.update", session: { type: "realtime", model: "gpt-realtime-2.1", instructions: "Hi" } });
    // Keys in another order are read whole, not by their start.
    const reordered = JSON.parse(call.lock(JSON.stringify({ session: { model: "gpt-realtime" }, type: "session.update" })) as string);
    expect(reordered.session.model).toBe("gpt-realtime-2.1");
    const untouched = [JSON.stringify({ type: "session.update", session: { instructions: "Hi" } }), JSON.stringify({ type: "response.create" }), "not json"];
    for (const frame of untouched) expect(call.lock(frame)).toBe(frame);
  });

  it("locks the model through an escaped type, a repeated type key and a repeated model key, and never parses an audio append (Gemini Neon, #270 round 1)", () => {
    const call = meter("gpt-realtime-2.1");
    const locked = (frame: string) => (JSON.parse(call.lock(frame) as string) as { session: { model: string } }).session.model;
    // An escaped dot in the type reads as session.update once parsed.
    expect(locked('{"type":"session\\u002eupdate","session":{"model":"gpt-realtime-2.1-mini"}}')).toBe("gpt-realtime-2.1");
    // A repeated type key: the last one wins when parsed.
    expect(locked('{"type":"response.create","type":"session.update","session":{"model":"gpt-realtime-2.1-mini"}}')).toBe("gpt-realtime-2.1");
    // A repeated model key: the frame is written again, so only the session's model is left.
    const twice = call.lock('{"type":"session.update","session":{"model":"gpt-realtime-2.1","model":"gpt-realtime-2.1-mini"}}') as string;
    expect(twice).not.toContain("gpt-realtime-2.1-mini");
    expect(locked(twice)).toBe("gpt-realtime-2.1");
    // The frame sent most goes as it is, unparsed.
    const append = JSON.stringify({ type: "input_audio_buffer.append", audio: "A".repeat(10_000) });
    expect(call.lock(append)).toBe(append);
  });

  it("writes again any parsed frame with a session, so a repeated session or type key can't read differently at OpenAI (Gemini Neon, #270 round 2)", () => {
    const call = meter("gpt-realtime-2.1");
    // Two session keys: the last one, as parsed, is what goes on, once.
    const sessions = call.lock('{"type":"session.update","session":{"model":"gpt-realtime-2.1-mini"},"session":{"instructions":"Hi"}}') as string;
    expect(JSON.parse(sessions)).toEqual({ type: "session.update", session: { instructions: "Hi" } });
    expect(sessions).not.toContain("gpt-realtime-2.1-mini");
    // Two type keys around a session with a model: parsed as a session.update, and locked.
    const types = call.lock('{"type":"response.create","session":{"model":"gpt-realtime-2.1-mini"},"type":"session.update"}') as string;
    expect(JSON.parse(types)).toEqual({ type: "session.update", session: { model: "gpt-realtime-2.1" } });
    // A frame with no session key stays as it was.
    const other = '{"type":"response.create","response":{"instructions":"x"},"type":"response.create"}';
    expect(call.lock(other)).toBe(other);
  });

  it("keeps each transcription model's usage apart in the slice: a switch mid-slice never mixes them (Sol, #270 round 1)", () => {
    const journal = newJournal(0);
    addUsage(journal, { id: "r1", measures: { input_tokens: 10 } }, "per_turn", 1);
    expect(freeze(journal, 1_000)).not.toHaveProperty("transcriptions");
    addUsage(journal, { id: "t1", measures: { transcription_audio_ms: 2_000 }, model: "whisper-1" }, "per_turn", 1_500);
    addUsage(journal, { id: "t2", measures: { transcription_input_tokens: 10 }, model: "gpt-4o-mini-transcribe" }, "per_turn", 1_600);
    addUsage(journal, { id: "t3", measures: { transcription_input_tokens: 5 }, model: "gpt-4o-mini-transcribe" }, "per_turn", 1_700);
    expect(freeze(journal, 2_000)).toMatchObject({
      measures: {},
      transcriptions: { "whisper-1": { transcription_audio_ms: 2_000 }, "gpt-4o-mini-transcribe": { transcription_input_tokens: 15 } },
    });
    // The next slice starts with none.
    addUsage(journal, { id: "r2", measures: { input_tokens: 1 } }, "per_turn", 2_500);
    expect(freeze(journal, 3_000)).not.toHaveProperty("transcriptions");
  });

  it("waits for each committed item's transcription until it completes, fails, or the item is deleted, and names a malformed model unknown (Sol, #270; Fable, #270 round 1)", () => {
    const call = meter();
    call.see(session({ audio: { input: { transcription: { model: "whisper-1" } } } }), true);
    for (const item of ["item_1", "item_2", "item_3"]) call.see(JSON.stringify({ type: "input_audio_buffer.committed", event_id: "e", item_id: item }), true);
    expect(call.pending()).toBe(true);
    expect(call.see(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "t1", item_id: "item_1" }), true)).toBe("item:item_1");
    // Labelled with the model the session names at its completion.
    expect(call.label({ id: "t", measures: { transcription_audio_ms: 1_000 } })).toMatchObject({ model: "whisper-1" });
    call.settled("item:item_1");
    call.settled(call.see(JSON.stringify({ type: "conversation.item.input_audio_transcription.failed", event_id: "t2", item_id: "item_2" }), true)!);
    expect(call.pending()).toBe(true);
    call.settled(call.see(JSON.stringify({ type: "conversation.item.deleted", event_id: "t3", item_id: "item_3" }), true)!);
    expect(call.pending()).toBe(false);
    // A model name the gateway would not take is never sent: it is `unknown`.
    call.see(session({ audio: { input: { transcription: { model: "bad name with spaces" } } } }), true);
    expect(call.label({ id: "t", measures: { transcription_audio_ms: 1 } })).toMatchObject({ model: "unknown" });
  });

});

describe("the session object with an OpenAI call (step 9e)", () => {
  /** The session object without its constructor, its core a stand-in that records the usage it was given. */
  function setup() {
    const recorded: unknown[] = [];
    const told: string[] = [];
    const core = {
      idle: false,
      ending: null,
      call: {},
      recordUsage: async (event: unknown, _shape: unknown, written?: () => void) => {
        recorded.push(event);
        written?.();
      },
      turnDone: () => void told.push("done"),
    };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const sent: unknown[] = [];
    const call = { send: (data: unknown) => sent.push(data), meter: meter("gpt-realtime-2.1") };
    const live = {
      client: { send: () => undefined },
      deadline: Infinity,
      call,
      adapter: OPENAI,
      frames: new SessionFrames({ relayMessages: false }),
      turnOpen: false,
      turns: 0,
    };
    (object as unknown as { live: unknown }).live = live;
    return { object, live, recorded, sent, told, call };
  }

  it("locks the model on the client's frames before they go to OpenAI", () => {
    const { object, live, sent } = setup();
    object.toProvider(live as never, JSON.stringify({ type: "session.update", session: { model: "gpt-realtime-2.1-mini" } }));
    expect(JSON.parse(sent[0] as string).session.model).toBe("gpt-realtime-2.1");
  });

  it("books a transcription under the model OpenAI stated, and an answer's usage under the session's", async () => {
    const { object, live, recorded, told } = setup();
    object.toClient(live as never, session({ audio: { input: { transcription: { model: "gpt-4o-transcribe" } } } }));
    object.toClient(
      live as never,
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "event_t1", usage: { type: "tokens", input_tokens: 30, output_tokens: 4 } }),
    );
    object.toClient(live as never, '{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}');
    object.toClient(live as never, done("resp_1", USAGE));
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(recorded).toEqual([
      { id: "event_t1", measures: { transcription_input_tokens: 30, transcription_output_tokens: 4 }, model: "gpt-4o-transcribe" },
      { id: "resp_1", measures: openAiMeasures(USAGE) },
    ]);
    expect(told).toEqual(["done"]);
    expect(live.turnOpen).toBe(false);
  });
});

describe("an OpenAI session's closing wait (Sol, #270 round 2)", () => {
  it("a side answer finishing never releases the wait while the voice answer runs; the last answer's written usage does", async () => {
    const told: string[] = [];
    let write: () => void = () => undefined;
    const core = {
      idle: false,
      ending: null,
      call: {},
      recordUsage: (event: { id: string }, _shape: unknown, written?: () => void) =>
        event.id === "resp_voice"
          ? new Promise<void>((resolve) => {
              write = () => {
                told.push("voice usage");
                written?.();
                resolve();
              };
            })
          : Promise.resolve().then(() => {
              told.push(`${event.id} usage`);
              written?.();
            }),
      turnDone: () => void told.push("done"),
    };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const call = { send: () => undefined, meter: meter("gpt-realtime-2.1") };
    const live = { client: { send: () => undefined }, deadline: Infinity, call, adapter: OPENAI, frames: new SessionFrames({ relayMessages: false }), turnOpen: false, turns: 0 };
    (object as unknown as { live: unknown }).live = live;
    object.toClient(live as never, '{"type":"response.created","event_id":"e1","response":{"id":"resp_voice"}}');
    object.toClient(live as never, '{"type":"response.created","event_id":"e2","response":{"id":"resp_side","conversation_id":null}}');
    object.toClient(live as never, done("resp_side", { input_tokens: 5, output_tokens: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(told).toEqual(["resp_side usage"]);
    expect(call.meter.pending()).toBe(true);
    // The voice answer finishes, but its usage isn't written yet: still waited for.
    object.toClient(live as never, done("resp_voice", USAGE));
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(call.meter.pending()).toBe(true);
    expect(told).not.toContain("done");
    write();
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(told).toEqual(["resp_side usage", "voice usage", "done"]);
    expect(call.meter.pending()).toBe(false);
  });
});

describe("a transcription still to come when an OpenAI session closes (Sol, #270 round 1)", () => {
  it("the answer's end does not release the closing wait while a transcription is still to come; its arrival does", async () => {
    const told: string[] = [];
    const core = {
      idle: false,
      ending: null,
      call: {},
      recordUsage: async (_event: unknown, _shape: unknown, written?: () => void) => {
        told.push("usage");
        written?.();
      },
      turnDone: () => void told.push("done"),
    };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const call = { send: () => undefined, meter: meter("gpt-realtime-2.1") };
    const live = { client: { send: () => undefined }, deadline: Infinity, call, adapter: OPENAI, frames: new SessionFrames({ relayMessages: false }), turnOpen: false, turns: 0 };
    (object as unknown as { live: unknown }).live = live;
    object.toClient(live as never, session({ audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } }));
    object.toClient(live as never, JSON.stringify({ type: "input_audio_buffer.committed", event_id: "e", item_id: "item_1" }));
    object.toClient(live as never, '{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}');
    object.toClient(live as never, done("resp_1", USAGE));
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(told).toEqual(["usage"]);
    object.toClient(live as never, JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "t1", item_id: "item_1", usage: { type: "tokens", input_tokens: 9, output_tokens: 2 } }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // real-timer: lets the promise chain run, no time passes
    expect(told).toEqual(["usage", "usage", "done"]);
  });

  it("a transcription still to come at the wait's cutoff marks the final slice partial: unknown cost, never free", async () => {
    let now = 1_000_000;
    const slices: { gaps: number }[] = [];
    const call = meter("gpt-realtime-2.1");
    call.see(session({ audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } }), true);
    const core = new SessionCore({
      store: new MemoryStore(),
      now: () => now,
      log: () => undefined,
      wait: async () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }) as never },
      main: {
        open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime-2.1" }) as never,
        checkpoint: async (_ticket: string, input: { slice: { gaps: number } | null }) => {
          if (input.slice !== null) slices.push(structuredClone(input.slice));
          return { decision: "continue", reasons: [], written: true } as never;
        },
        close: async () => ({ version: 2 }),
      },
      provider: { connect: async () => ({ callId: null, close: () => undefined, estimate: () => call.estimate() }) },
      turnOpen: () => call.pending(),
    });
    const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.realtime", model: "gpt-realtime-2.1" });
    await core.start(text, ticket, { close: () => undefined });
    call.see(JSON.stringify({ type: "input_audio_buffer.committed", event_id: "e", item_id: "item_1" }), true);
    now += 5_000;
    await core.end("client_closed");
    expect(slices.at(-1)?.gaps).toBeGreaterThan(0);
  });
});

describe("a journal write that fails before the close (Sol, #270 round 3)", () => {
  it("carries the usage a failed write left out into the final write, when both journals agree on the open usage (Sol, #270 rounds 3 and 4)", async () => {
    const run = async (recover: boolean) => {
      let now = 1_000_000;
      const store = new MemoryStore();
      const slices: { gaps: number; measures: Record<string, number> }[] = [];
      const core = new SessionCore({
        store,
        now: () => now,
        log: () => undefined,
        vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }) as never },
        main: {
          open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime-2.1" }) as never,
          checkpoint: async (_ticket: string, input: { slice: { gaps: number; measures: Record<string, number> } | null }) => {
            if (input.slice !== null) slices.push(structuredClone(input.slice));
            return { decision: "continue", reasons: [], written: true } as never;
          },
          close: async () => ({ version: 2 }),
        },
        provider: { connect: async () => ({ callId: null, close: () => undefined }) },
      });
      const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.realtime", model: "gpt-realtime-2.1" });
      await core.start(text, ticket, { close: () => undefined });
      const write = store.putJournal.bind(store);
      store.putJournal = () => Promise.reject(new Error("storage failed"));
      await core.recordUsage({ id: "resp_1", measures: { input_tokens: 100, output_tokens: 20 } }, "per_turn");
      store.putJournal = write;
      if (recover) await core.recordUsage({ id: "resp_2", measures: { input_tokens: 1, output_tokens: 1 } }, "per_turn");
      now += 5_000;
      await core.end("client_closed");
      return slices.at(-1);
    };
    // The answer's usage never reached storage, but this instance held it, for the same open usage: carried into
    // the final write, so the slice is complete (Sol, #270 round 4).
    expect(await run(false)).toMatchObject({ gaps: 0, measures: { input_tokens: 100, output_tokens: 20 } });
    // A later write held the whole journal: complete, with both answers.
    expect(await run(true)).toMatchObject({ gaps: 0, measures: { input_tokens: 101, output_tokens: 21 } });
    // Journals that disagree on the open usage (a slice frozen since) carry nothing: the slice stays partial.
    const stored = newJournal(0);
    const memory = newJournal(0);
    addUsage(memory, { id: "r", measures: { input_tokens: 5 } }, "per_turn", 1);
    freeze(memory, 10);
    expect(carryOpen(stored, memory)).toBe(false);
    expect(stored.measures).toEqual({});
    // Journals that agree: a dropped event's gap and a side channel's time detached go along, the earlier start kept (Gemini Neon, #270 round 2).
    const kept = newJournal(0);
    kept.droppedFrom = 300;
    kept.detachedFrom = 200;
    const seen = newJournal(0);
    seen.droppedFrom = 400;
    seen.detachedFrom = 100;
    seen.detachedMs = 50;
    expect(carryOpen(kept, seen)).toBe(true);
    expect(kept).toMatchObject({ droppedFrom: 300, detachedFrom: 100, detachedMs: 50 });
    // Attached again in memory: no longer detached, its time in detachedMs.
    const attached = newJournal(0);
    attached.detachedFrom = 100;
    const again = newJournal(0);
    again.detachedMs = 80;
    carryOpen(attached, again);
    expect(attached.detachedFrom).toBeUndefined();
    expect(attached.detachedMs).toBe(80);
  });
});

describe("an answer that finishes just before the session's cap (Gemini Neon, #270 round 1)", () => {
  it("is not cut: the end waits for its usage write, on local storage, before it judges what is cut", async () => {
    let now = 1_000_000;
    const store = new MemoryStore();
    const slices: { gaps: number; measures: Record<string, number> }[] = [];
    const call = meter("gpt-realtime-2.1");
    const core = new SessionCore({
      store,
      now: () => now,
      log: () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }) as never },
      main: {
        open: async () => ({ deadline: now + 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime-2.1" }) as never,
        checkpoint: async (_ticket: string, input: { slice: { gaps: number; measures: Record<string, number> } | null }) => {
          if (input.slice !== null) slices.push(structuredClone(input.slice));
          return { decision: "continue", reasons: [], written: true } as never;
        },
        close: async () => ({ version: 2 }),
      },
      provider: { connect: async () => ({ callId: null, close: () => undefined, estimate: () => call.estimate() }) },
      turnOpen: () => call.pending(),
    });
    const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.realtime", model: "gpt-realtime-2.1" });
    await core.start(text, ticket, { close: () => undefined });
    call.see('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}', true);
    const key = call.see(done("resp_1", USAGE), true)!;
    // Its usage write is slow: the cap comes while it is in flight.
    const write = store.putJournal.bind(store);
    let land: (() => void) | null = null;
    store.putJournal = (journal: unknown) => new Promise<void>((resolve) => (land = () => void write(journal).then(resolve)));
    const recorded = core.recordUsage({ id: "resp_1", measures: { input_tokens: 70, output_tokens: 40 } }, "per_turn", () => call.settled(key));
    await until(() => land !== null);
    now += 60_000;
    const ended = core.end("time_cap");
    await Promise.resolve();
    store.putJournal = write;
    land!();
    await Promise.all([recorded, ended]);
    expect(slices.at(-1)).toMatchObject({ gaps: 0, measures: { input_tokens: 70, output_tokens: 40 } });
  });
});

describe("the end path's usage writes (Sol, Gemini Neon, #270 round 5)", () => {
  type Slice = { gaps: number; measures: Record<string, number>; transcriptions?: Record<string, Record<string, number>> };
  /** A core on an OpenAI call whose meter is `call`; the closing wait and the end's write wait use `wait`. */
  async function endSession(wait: (ms: number) => Promise<void>, started = true) {
    const now = 1_000_000;
    const store = new MemoryStore();
    const slices: Slice[] = [];
    const logs: string[] = [];
    const call = meter("gpt-realtime-2.1");
    const core = new SessionCore({
      store,
      now: () => now,
      log: (event: Record<string, unknown>) => void logs.push(String(event.message)),
      wait,
      vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }) as never },
      main: {
        open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime-2.1" }) as never,
        checkpoint: async (_ticket: string, input: { slice: Slice | null }) => {
          if (input.slice !== null) slices.push(structuredClone(input.slice));
          return { decision: "continue", reasons: [], written: true } as never;
        },
        close: async () => ({ version: 2 }),
      },
      provider: { connect: async () => ({ callId: null, close: () => undefined, estimate: () => call.estimate() }) },
      turnOpen: () => call.pending(),
      unfinished: () => call.unfinished(),
    });
    const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.realtime", model: "gpt-realtime-2.1" });
    const start = () => core.start(text, ticket, { close: () => undefined });
    if (started) await start();
    /** A provider frame the meter sees, and its usage written as the session object writes it. */
    const usage = (frame: string, event: { id: string; measures: Record<string, number>; model?: string }) => {
      const key = call.see(frame, true);
      return core.recordUsage(event, "per_turn", () => {
        if (key === null) return;
        call.settled(key);
        if (!call.pending()) core.turnDone();
      });
    };
    return { core, store, slices, call, usage, logs, start };
  }
  const onlyWritesWait = (ms: number) => (ms === END_WRITES_MS ? Promise.resolve() : never<void>());

  it("counts a response.done that arrives while the end waits for the answer", async () => {
    const s = await endSession(never);
    s.call.see('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}', true);
    const ended = s.core.end("client_closed");
    await Promise.resolve();
    await s.usage(done("resp_1", USAGE), { id: "resp_1", measures: { input_tokens: 70, output_tokens: 40 } });
    await ended;
    expect(s.slices.at(-1)).toMatchObject({ gaps: 0, measures: { input_tokens: 70, output_tokens: 40 } });
  });

  it("counts a transcription that arrives while the end waits for it", async () => {
    const s = await endSession(never);
    s.call.see(session({ audio: { input: { transcription: { model: "whisper-1" } } } }), true);
    s.call.see(JSON.stringify({ type: "input_audio_buffer.committed", event_id: "c", item_id: "item_1" }), true);
    const ended = s.core.end("client_closed");
    await Promise.resolve();
    const frame = JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: "t1", item_id: "item_1" });
    await s.usage(frame, { id: "t1", measures: { transcription_audio_ms: 1_500 }, model: "whisper-1" });
    await ended;
    expect(s.slices.at(-1)).toMatchObject({ gaps: 0, transcriptions: { "whisper-1": { transcription_audio_ms: 1_500 } } });
  });

  it("waits for every write in flight, the slower one too, at the cap", async () => {
    const s = await endSession(never);
    const write = s.store.putJournal.bind(s.store);
    const lands: (() => void)[] = [];
    s.store.putJournal = (journal: unknown) => new Promise<void>((resolve) => lands.push(() => void write(journal).then(resolve)));
    s.call.see('{"type":"response.created","event_id":"e1","response":{"id":"r1"}}', true);
    s.call.see('{"type":"response.created","event_id":"e2","response":{"id":"r2"}}', true);
    const first = s.usage(done("r1", USAGE), { id: "r1", measures: { input_tokens: 10, output_tokens: 1 } });
    const second = s.usage(done("r2", USAGE), { id: "r2", measures: { input_tokens: 20, output_tokens: 2 } });
    await until(() => lands.length === 2);
    s.store.putJournal = write;
    // The cap: the faster second write lands while the first is still in flight.
    const ended = s.core.end("time_cap");
    lands[1]!();
    await Promise.resolve();
    lands[0]!();
    await Promise.all([first, second, ended]);
    expect(s.slices.at(-1)).toMatchObject({ gaps: 0, measures: { input_tokens: 30, output_tokens: 3 } });
  });

  it("never lets a write that doesn't settle hold the end: the session closes, and its last slice is partial, not cut (Sol, #270 round 6)", async () => {
    const s = await endSession(onlyWritesWait);
    const write = s.store.putJournal.bind(s.store);
    let stuck = false;
    s.store.putJournal = () => ((stuck = true), never<void>());
    s.call.see('{"type":"response.created","event_id":"e","response":{"id":"r1"}}', true);
    void s.usage(done("r1", USAGE), { id: "r1", measures: { input_tokens: 10, output_tokens: 1 } });
    await until(() => stuck);
    // Only that write hangs: the end's own writes go through.
    s.store.putJournal = write;
    await s.core.end("time_cap");
    expect(s.slices.at(-1)?.gaps).toBeGreaterThan(0);
    // OpenAI finished the answer: its write ran late, so the slice is partial, but nothing was cut or estimated.
    expect(s.logs).not.toContain("relay_answer_cut");
    expect(s.slices.at(-1)?.measures).not.toHaveProperty("estimated_tokens");
  });

  it("an end that finds nothing to end leaves no stop behind: a start on the same instance after it records its usage (Sol, Gemini Neon, #270 round 6)", async () => {
    const s = await endSession(never, false);
    // The first start failed before anything was stored: its end finds no session.
    await s.core.end("error");
    await s.start();
    await s.core.recordUsage({ id: "r1", measures: { input_tokens: 12, output_tokens: 3 } }, "per_turn");
    await s.core.end("client_closed");
    expect(s.slices.at(-1)).toMatchObject({ measures: { input_tokens: 12, output_tokens: 3 } });
  });
});

describe("an OpenAI session's end cuts an answer (step 9e)", () => {
  type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number };

  it("at the time cap, bills the cut answer's estimate in the final slice, marked partial by its gap, never as free", async () => {
    let now = 1_000_000;
    const store = new MemoryStore();
    const slices: Slice[] = [];
    const call = meter("gpt-realtime-2.1");
    const core = new SessionCore({
      store,
      now: () => now,
      log: () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime" }) as never },
      main: {
        open: async () => ({ deadline: now + 60_000, mode: "relayed", operation: "openai.realtime", checkpointIntervalMs: 60_000, version: 2, adapter: "openai", model: "gpt-realtime-2.1" }) as never,
        checkpoint: async (_ticket: string, input: { slice: Slice | null }) => {
          if (input.slice !== null) slices.push(structuredClone(input.slice));
          return { decision: "continue", reasons: [], written: true } as never;
        },
        close: async () => ({ version: 2 }),
      },
      provider: { connect: async () => ({ callId: null, close: () => undefined, estimate: () => call.estimate() }) },
      turnOpen: () => true,
    });
    const { text, ticket } = ticketFor(now, { providerType: "openai", operation: "openai.realtime", model: "gpt-realtime-2.1" });
    await core.start(text, ticket, { close: () => undefined });
    call.see('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}', true);
    call.see(delta(64_000), true);
    now += 60_000;
    await core.end("time_cap");
    const final = slices.at(-1)!;
    expect(final.measures).toMatchObject({ output_tokens: 21, output_audio_tokens: 21, estimated_tokens: 21 });
    expect(final.gapMs).toBeGreaterThanOrEqual(0);
    expect(final.gaps).toBeGreaterThan(0);
  });
});
