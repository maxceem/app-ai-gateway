/**
 * ElevenLabs' and Deepgram's streaming voice through the relay (step 10a). ElevenLabs bills the text it is
 * sent, so its adapter counts the client's text frames through the client-frame hook (9a); Deepgram is billed,
 * as xAI is, at the larger of the relay's clock from the first audio and the audio Deepgram reports it heard.
 * The session core runs against stand-ins, as in `relay-xai.test.ts`; its clock is the test's own.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, withoutCredentials } from "../relay/src/adapters.js";
import { Session } from "../relay/src/index.js";
import { SessionFrames } from "../relay/src/frames.js";
import { connectProvider } from "../relay/src/provider.js";
import { END_WRITES_MS, SessionCore } from "../relay/src/start.js";
import { MemoryStore, never, ticketFor, until } from "./relay-stand-ins.ts";

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number; billedMs?: number };

/** A session core on `adapter`, with stand-ins and the test's clock; `wait` resolves only when the test says. */
function setup(adapter: "elevenlabs_tts" | "deepgram") {
  let now = 1_000_000;
  const store = new MemoryStore();
  const checkpoints: (Slice | null)[] = [];
  const closes: { endReason: string; finalSlice: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const timers: { at: number; resolve: () => void }[] = [];
  const operation = adapter === "deepgram" ? "deepgram.listen_stream" : "elevenlabs.tts_websocket";
  const parts = () => ({
    store,
    now: () => now,
    log: (event: Record<string, unknown>) => logs.push(event),
    // The closing and end waits use the test's clock: a timer fires when the test moves it past.
    wait: (ms: number) => new Promise<void>((resolve) => timers.push({ at: now + ms, resolve })),
    vault: { sessionKey: async () => ({ key: { value: "k", header: "xi-api-key", format: "{key}" }, target: "https://provider.test/stream" }) as never },
    main: {
      open: async () => ({ deadline: now + 30 * 60_000, mode: "relayed", operation, checkpointIntervalMs: 60_000, version: 2, adapter }) as never,
      checkpoint: async (_ticket: string, input: { slice: Slice | null }) => {
        checkpoints.push(structuredClone(input.slice));
        return { decision: "continue", reasons: [], written: true } as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number }) => {
        closes.push({ endReason: input.endReason, finalSlice: input.finalSlice });
        return { version: 2 };
      },
    },
    provider: { connect: async () => ({ callId: adapter === "deepgram" ? "dg-req-1" : null, close: () => undefined }) },
  });
  const { text, ticket } = ticketFor(now, { providerType: adapter === "deepgram" ? "deepgram" : "elevenlabs", operation, model: "m", slot: "streaming" });
  const tick = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((one) => one.at <= now)) timer.resolve();
  };
  return {
    store,
    closes,
    logs,
    slices: () => checkpoints.filter((slice): slice is Slice => slice !== null),
    text,
    ticket,
    client: { close: () => undefined },
    instance: () => new SessionCore(parts()),
    tick,
    timers,
  };
}

describe("ElevenLabs streaming text to speech: the client's text is counted (step 10a)", () => {
  const client = adapterFor("elevenlabs_tts").client!;

  it("counts each text frame's characters as a person counts them, and nothing for white space, binary or unreadable frames", () => {
    const state = {};
    // The opening frame is a single space, and the closing one empty: neither is billed.
    expect(client(JSON.stringify({ text: " ", voice_settings: { stability: 0.5 } }), state)).toBeNull();
    expect(client(JSON.stringify({ text: "" }), state)).toBeNull();
    // Code points, not UTF-16 units: the emoji is one character, as a call's text is counted.
    expect(client(JSON.stringify({ text: "Héllo 👋 " }), state)).toEqual({ counts: { characters: 8 } });
    expect(client(JSON.stringify({ text: "Again, flushed.", flush: true }), state)).toEqual({ counts: { characters: 15 } });
    expect(client(new Uint8Array([1, 2]).buffer, state)).toBeNull();
    expect(client("not json", state)).toBeNull();
    expect(client(JSON.stringify({ text: 42 }), state)).toBeNull();
  });

  it("marks every later character an estimate once a frame names a pronunciation dictionary, as a call is", () => {
    const state = {};
    expect(client(JSON.stringify({ text: "Before " }), state)).toEqual({ counts: { characters: 7 } });
    expect(client(JSON.stringify({ text: " ", pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: "d", version_id: "v" }] }), state)).toBeNull();
    expect(client(JSON.stringify({ text: "After " }), state)).toEqual({ counts: { characters: 6, estimated_characters: 6 } });
    // An empty list names none.
    expect(client(JSON.stringify({ text: "Plain ", pronunciation_dictionary_locators: [] }), {})).toEqual({ counts: { characters: 6 } });
  });

  it("removes ElevenLabs' two credential fields from a client's message, written again whole, and drops a binary frame (Sol and Fable, #273 round 1)", () => {
    const init = { text: " ", voice_settings: { stability: 0.5 }, "xi-api-key": "theirs", authorization: "Bearer theirs" };
    expect(JSON.parse(withoutCredentials(JSON.stringify(init))!)).toEqual({ text: " ", voice_settings: { stability: 0.5 } });
    // An escaped name and a repeated key are read as ElevenLabs reads them.
    expect(JSON.parse(withoutCredentials('{"text":" ","xi-api-\\u006bey":"a","xi-api-key":"b"}')!)).toEqual({ text: " " });
    const plain = JSON.stringify({ text: "Hello ", flush: true });
    expect(withoutCredentials(plain)).toBe(plain);
    expect(withoutCredentials("not json")).toBe("not json");
    // ElevenLabs' documented first message spells the key `xi_api_key` (Sol, #273 round 3).
    const documented = { text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 }, xi_api_key: "<XI_API_KEY>" };
    expect(JSON.parse(withoutCredentials(JSON.stringify(documented))!)).toEqual({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 } });
    // ElevenLabs' messages are JSON text: a binary frame would go unchecked and unbilled.
    expect(withoutCredentials(new Uint8Array([1]).buffer)).toBeNull();
  });

  it("the session object sends ElevenLabs the message without the client's credentials, and never a binary frame, through the adapter's lock", () => {
    const told: unknown[] = [];
    const core = { idle: false, ending: null, call: {}, count: async (counts: unknown) => void told.push(counts), countText: async () => undefined };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const sent: unknown[] = [];
    const adapter = adapterFor("elevenlabs_tts");
    const live = {
      client: { send: () => undefined },
      deadline: Infinity,
      call: { send: (data: unknown) => sent.push(data) },
      adapter,
      frames: new SessionFrames({ relayMessages: false }),
      turnOpen: false,
      turns: 0,
      clientState: {},
    };
    object.toProvider(live as never, JSON.stringify({ text: " ", "xi-api-key": "theirs" }));
    object.toProvider(live as never, new TextEncoder().encode(JSON.stringify({ text: "Free text? " })).buffer);
    expect(sent).toEqual([JSON.stringify({ text: " " })]);
    expect(told).toEqual([]);
  });

  it("reads no provider frame, never starts a clock, and keeps no turn open: its answers bill nothing", () => {
    const adapter = adapterFor("elevenlabs_tts");
    expect(adapter.clock).toBeUndefined();
    expect(adapter.read(JSON.stringify({ audio: "AAAA", isFinal: null }))).toBeNull();
    expect(adapter.turn(JSON.stringify({ isFinal: true }))).toBeNull();
  });

  it("the session object counts a text frame only after it went to ElevenLabs, with the session's own memory of dictionaries", () => {
    const told: unknown[] = [];
    const core = { idle: false, ending: null, call: {}, count: async (counts: unknown) => void told.push(counts), countText: async () => void told.push("text") };
    const object = Object.create(Session.prototype) as Session;
    (object as unknown as { core: unknown }).core = core;
    const sent: unknown[] = [];
    const live = {
      client: { send: () => undefined },
      deadline: Infinity,
      call: { send: (data: unknown) => sent.push(data) },
      adapter: adapterFor("elevenlabs_tts"),
      frames: new SessionFrames({ relayMessages: false }),
      turnOpen: false,
      turns: 0,
      clientState: {},
    };
    object.toProvider(live as never, JSON.stringify({ text: " ", pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: "d" }] }));
    object.toProvider(live as never, JSON.stringify({ text: "Hi there " }));
    expect(sent).toHaveLength(2);
    expect(told).toEqual([{ characters: 9, estimated_characters: 9 }]);
    // Past the deadline nothing goes, and nothing is counted.
    live.deadline = 0;
    (object as unknown as { core: { end: () => Promise<void> } }).core.end = async () => undefined;
    object.toProvider(live as never, JSON.stringify({ text: "Late " }));
    expect(sent).toHaveLength(2);
    expect(told).toHaveLength(1);
  });

  it("books the characters in slices, bills no clock, and the final slice has the text sent just before the client hung up", async () => {
    const s = setup("elevenlabs_tts");
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.count({ characters: 120 });
    s.tick(61_000);
    await core.alarm();
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, measures: { characters: 120 }, sessionMs: 61_000, gapMs: 0 })]);
    expect(s.slices()[0]?.billedMs).toBeUndefined();
    // The last text's write is in flight when the client hangs up: the end waits for it (bounded).
    let land: () => void = () => undefined;
    const write = s.store.putJournal.bind(s.store);
    s.store.putJournal = (journal) => new Promise((resolve) => (land = () => void write(journal).then(resolve)));
    const counting = core.count({ characters: 30, estimated_characters: 30 });
    const ending = core.end("client_closed");
    await until(() => s.timers.length > 0);
    land();
    await counting;
    s.store.putJournal = write;
    await ending;
    expect(s.slices().at(-1)).toMatchObject({ seq: 2, measures: { characters: 30, estimated_characters: 30 }, gapMs: 0 });
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 2 }]);
  });

  it("an end whose last count never lands books what it has, partial, after the 2 s wait", async () => {
    const s = setup("elevenlabs_tts");
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.count({ characters: 40 });
    const write = s.store.putJournal.bind(s.store);
    s.store.putJournal = () => never();
    void core.count({ characters: 10 });
    const ending = core.end("client_closed");
    await until(() => s.timers.length > 0);
    s.store.putJournal = write;
    s.tick(END_WRITES_MS);
    await ending;
    // The count in memory was carried into the final slice; its write never confirmed, so the slice is partial.
    const last = s.slices().at(-1)!;
    expect(last.measures.characters).toBeGreaterThanOrEqual(40);
    expect(last.gaps).toBeGreaterThan(0);
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 1 }]);
  });

  it("a restarted instance ends the session, with the time since the last write as a gap, and the characters it wrote kept", async () => {
    const s = setup("elevenlabs_tts");
    const first = s.instance();
    await first.start(s.text, s.ticket, s.client);
    await first.count({ characters: 55 });
    s.tick(10_000);
    await s.instance().alarm();
    expect(s.closes).toEqual([{ endReason: "error", finalSlice: 1 }]);
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, measures: { characters: 55 }, gapMs: 10_000, gaps: 1 })]);
  });
});

describe("Deepgram streaming speech to text: metered as Deepgram reports it, or the clock (step 10a)", () => {
  const adapter = adapterFor("deepgram");

  it("reads the audio Deepgram heard from its Results and its closing Metadata, for each channel billed", () => {
    const results = (start: number, duration: number, channels = 1) =>
      JSON.stringify({ type: "Results", channel_index: [0, channels], duration, start, is_final: true, channel: { alternatives: [{ transcript: "hi" }] }, metadata: { request_id: "r" } });
    expect(adapter.read(results(0, 1.5))).toMatchObject({ audioSeconds: 1.5 });
    expect(adapter.read(results(12.25, 2))).toMatchObject({ audioSeconds: 14.25 });
    // Two channels billed apart (`multichannel`): both count.
    expect(adapter.read(results(10, 2, 2))).toMatchObject({ audioSeconds: 24 });
    expect(adapter.read(JSON.stringify({ type: "Metadata", request_id: "r", duration: 31.5, channels: 1 }))).toMatchObject({ audioSeconds: 31.5 });
    expect(adapter.read(JSON.stringify({ type: "Metadata", request_id: "r", duration: 10, channels: 2 }))).toMatchObject({ audioSeconds: 20 });
    // The type need not come first.
    expect(adapter.read(JSON.stringify({ duration: 3, start: 1, type: "Results" }))).toMatchObject({ audioSeconds: 4 });
    for (const other of [
      JSON.stringify({ type: "UtteranceEnd", last_word_end: 3 }),
      JSON.stringify({ type: "SpeechStarted", timestamp: 1 }),
      JSON.stringify({ type: "Results", duration: "1" }),
      JSON.stringify({ type: "Metadata", duration: -1 }),
      "{",
    ]) {
      expect(adapter.read(other), other).toBeNull();
    }
    expect(adapter.read(new Uint8Array([1]).buffer)).toBeNull();
  });

  it("reads keyterms Deepgram confirms in ConfigureSuccess, and only a non-empty list (Sol, #273 round 3)", () => {
    expect(adapter.read(JSON.stringify({ type: "ConfigureSuccess", request_id: "r", keyterms: ["Acme"] }))).toEqual({ id: "", measures: {}, keyterms: true });
    expect(adapter.read(JSON.stringify({ type: "ConfigureSuccess", request_id: "r", keyterms: [] }))).toBeNull();
    expect(adapter.read(JSON.stringify({ type: "ConfigureSuccess", request_id: "r" }))).toBeNull();
    expect(adapter.read(JSON.stringify({ type: "ConfigureFailure", code: "CONFIGURE_KEYTERMS_NOT_SUPPORTED" }))).toBeNull();
  });

  it("marks every slice after Deepgram confirmed keyterms, the one it came in too, and never before (Sol, #273 round 3)", async () => {
    const s = setup("deepgram");
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.activity();
    s.tick(61_000);
    await core.alarm();
    await core.recordUsage({ id: "", measures: {}, keyterms: true }, "running_total");
    s.tick(61_000);
    await core.alarm();
    s.tick(10_000);
    await core.end("provider_closed");
    const slices = s.slices() as (Slice & { keyterms?: true })[];
    expect(slices.map((slice) => slice.keyterms === true)).toEqual([false, true, true]);
  });

  it("starts the clock at the client's first audio frame, never at a KeepAlive, and names its call by Deepgram's request id header", () => {
    expect(adapter.clock).toBe("first_activity");
    expect(adapter.client!(new Uint8Array(3200).buffer)).toBe("activity");
    expect(adapter.client!(JSON.stringify({ type: "KeepAlive" }))).toBeNull();
    expect(adapter.client!(JSON.stringify({ type: "CloseStream" }))).toBeNull();
    expect(adapter.callIdHeader).toBe("dg-request-id");
  });

  it("bills nothing before the first audio, then the larger of the clock and Deepgram's audio, each slice the growth only", async () => {
    const s = setup("deepgram");
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    // Free until the first audio.
    s.tick(20_000);
    await core.activity();
    // Slice 1: Deepgram heard 50 s of audio sent faster than real time in 30 s: the audio bills.
    s.tick(30_000);
    await core.recordUsage({ id: "", measures: {}, audioSeconds: 50 }, "running_total");
    s.tick(15_000);
    await core.alarm();
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, sessionMs: 45_000, billedMs: 50_000 })]);
    // Slice 2: the client paused with KeepAlives; Deepgram's figure stays, and the clock passes it: the clock bills.
    s.tick(60_000);
    await core.alarm();
    expect(s.slices().at(-1)).toMatchObject({ seq: 2, sessionMs: 60_000, billedMs: 55_000 });
    // A report out of order changes nothing.
    await core.recordUsage({ id: "", measures: {}, audioSeconds: 40 }, "running_total");
    s.tick(5_000);
    await core.end("provider_closed");
    expect(s.slices().at(-1)).toMatchObject({ seq: 3, sessionMs: 5_000, billedMs: 5_000 });
    expect(s.closes).toEqual([{ endReason: "provider_closed", finalSlice: 3 }]);
  });

  it("stores Deepgram's request id as the session's call id", async () => {
    const s = setup("deepgram");
    await s.instance().start(s.text, s.ticket, s.client);
    expect(s.store.data.get("callId")).toBe("dg-req-1");
  });

  it("an end that cuts Deepgram's last report short still bills the clock: never less than Deepgram", async () => {
    const s = setup("deepgram");
    const core = s.instance();
    await core.start(s.text, s.ticket, s.client);
    await core.activity();
    s.tick(4_000);
    await core.recordUsage({ id: "", measures: {}, audioSeconds: 2 }, "running_total");
    s.tick(8_000);
    await core.end("client_closed");
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, sessionMs: 12_000, billedMs: 12_000 })]);
  });

  it("keeps the first audio's time across a restart: the session ends, and only the time since the last write is a gap", async () => {
    const s = setup("deepgram");
    const first = s.instance();
    await first.start(s.text, s.ticket, s.client);
    s.tick(5_000);
    await first.activity();
    s.tick(10_000);
    await first.recordUsage({ id: "", measures: {}, audioSeconds: 10 }, "running_total");
    s.tick(20_000);
    await s.instance().alarm();
    expect(s.closes).toEqual([{ endReason: "error", finalSlice: 1 }]);
    // Up to the last write (10 s of audio heard, 10 s on the clock) is billed; the 20 s after it are a gap.
    expect(s.slices()).toEqual([expect.objectContaining({ seq: 1, sessionMs: 10_000, billedMs: 10_000, gapMs: 20_000, gaps: 1 })]);
  });
});

describe("the provider's call id from its answer header (step 10a)", () => {
  const socket = () => ({ accept: () => undefined, binaryType: "blob" }) as unknown as WebSocket;
  const answer = (headers: Record<string, string>) => async () =>
    ({ status: 101, webSocket: socket(), headers: new Headers(headers), body: null }) as unknown as Response;
  const key = { key: { value: "k", header: "authorization", format: "Token {key}" }, target: "https://api.deepgram.com/v1/listen" };

  it("keeps a plain id from the named header, and nothing else", async () => {
    const noWait = () => never();
    expect((await connectProvider(key, answer({ "dg-request-id": "5e2c1b7a-1f0d-4c2e-9e1b-0a1b2c3d4e5f" }), noWait, 15_000, "dg-request-id")).callId).toBe(
      "5e2c1b7a-1f0d-4c2e-9e1b-0a1b2c3d4e5f",
    );
    expect((await connectProvider(key, answer({ "dg-request-id": "a b/../c" }), noWait, 15_000, "dg-request-id")).callId).toBeNull();
    expect((await connectProvider(key, answer({}), noWait, 15_000, "dg-request-id")).callId).toBeNull();
    // An adapter that names no header keeps none, whatever the answer says.
    expect((await connectProvider(key, answer({ "dg-request-id": "r1" }), noWait)).callId).toBeNull();
  });
});
