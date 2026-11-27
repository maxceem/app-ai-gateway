/**
 * OpenAI Realtime over WebSocket through the relay (step 9e; plan, the
 * provider table: tokens per answer, plus input transcription billed apart).
 * The adapter's reading of OpenAI's frames (T8, T9, T21 shapes), the call's
 * memory (its audio format, its transcription model, the answer in progress),
 * the model lock, and the session core's estimate for an answer its own end cuts.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, openAiMeasures, transcriptionMeasures } from "../relay/src/adapters.js";
import { freeze, newJournal, addUsage } from "../relay/src/journal.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { SessionCore } from "../relay/src/start.js";
import { MemoryStore, ticketFor } from "./relay-stand-ins.ts";

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
      // 600 cached, of which 10 image tokens are billed as uncached: 590 at the cached rate.
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
    // A side with no breakdown is not split: it bills at the model's highest rate.
    expect(openAiMeasures({ input_tokens: 50, output_tokens: 7 })).toEqual({ input_tokens: 50, output_tokens: 7 });
  });

  it("reads the usage inside the frame that ends the answer, keyed by the response's id, and parses no audio delta", () => {
    const event = OPENAI.read(done("resp_1", USAGE));
    expect(event).toEqual({ id: "resp_1", measures: openAiMeasures(USAGE) });
    expect(OPENAI.turn(done("resp_1", USAGE))).toBe("done");
    expect(OPENAI.turn('{"type":"response.created","event_id":"e","response":{"id":"resp_1"}}')).toBe("open");
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
    // Before OpenAI said which model transcribes, the event goes as it is.
    expect(call.label(transcription)).toEqual(transcription);
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

  it("puts the transcription's model on the slice that carries its usage, and keeps it for the slices after", () => {
    const journal = newJournal(0);
    addUsage(journal, { id: "r1", measures: { input_tokens: 10 } }, "per_turn", 1);
    expect(freeze(journal, 1_000)).not.toHaveProperty("transcriptionModel");
    addUsage(journal, { id: "t1", measures: { transcription_input_tokens: 10 }, model: "gpt-4o-mini-transcribe" }, "per_turn", 1_500);
    expect(freeze(journal, 2_000)).toMatchObject({ measures: { transcription_input_tokens: 10 }, transcriptionModel: "gpt-4o-mini-transcribe" });
    addUsage(journal, { id: "t2", measures: { transcription_audio_ms: 900 } }, "per_turn", 2_500);
    expect(freeze(journal, 3_000)).toMatchObject({ transcriptionModel: "gpt-4o-mini-transcribe" });
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
      recordUsage: async (event: unknown) => void recorded.push(event),
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
    return { object, live, recorded, sent, told };
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
