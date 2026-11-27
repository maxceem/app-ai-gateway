/**
 * Gemini Live through the relay (step 9d; T4, T19): its adapter, the relay's
 * own upstream with its resumption and swaps (`relay/src/gemini.js`), and
 * the price of a slice by modality. The upstream runs against stand-in
 * sockets and a timer the test moves: no real wait.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, geminiMeasures, geminiMessage } from "../relay/src/adapters.js";
import { BYTES_PER_ESTIMATED_TOKEN, GeminiUpstream, GOAWAY_MARGIN_MS, OLD_CLOSE_WAIT_MS, RESUME_LIMIT_MS, RESUME_RETRY_MS } from "../relay/src/gemini.js";
import { billingForCharge, priceSources } from "../src/pricing/billability.ts";
import { priceSlice } from "../src/relay/checkpoint.ts";
import { until } from "./relay-stand-ins.ts";

/** A stand-in WebSocket: it keeps what was sent, and the test fires its frames and its close. */
class FakeSocket {
  readonly sent: (string | ArrayBuffer)[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly listeners: { message: ((event: { data: string | ArrayBuffer }) => void)[]; close: ((event: { code: number }) => void)[] } = { message: [], close: [] };
  addEventListener(type: "message" | "close", listener: (event: never) => void): void {
    (this.listeners[type] as unknown[]).push(listener);
  }
  send(data: string | ArrayBuffer): void {
    if (this.closedWith !== null) throw new Error("closed");
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.closedWith ??= { code, reason };
  }
  /** A frame from Gemini, as bytes (Gemini sends its JSON in binary frames). */
  emit(message: unknown): void {
    const data = new TextEncoder().encode(JSON.stringify(message)).buffer as ArrayBuffer;
    for (const listener of this.listeners.message) listener({ data });
  }
  fireClose(code = 1000): void {
    for (const listener of this.listeners.close) listener({ code });
  }
  /** What was sent, parsed. */
  messages(): Record<string, unknown>[] {
    return this.sent.map((data) => JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<string, unknown>);
  }
}

/** One turn's usage, as T4 logged it. */
const USAGE = {
  promptTokenCount: 638,
  responseTokenCount: 45,
  totalTokenCount: 683,
  promptTokensDetails: [
    { modality: "TEXT", tokenCount: 316 },
    { modality: "AUDIO", tokenCount: 295 },
  ],
  responseTokensDetails: [{ modality: "AUDIO", tokenCount: 45 }],
  thoughtsTokenCount: 54,
};

/** An answer's audio chunk, about the size Gemini sends (T19: 300 ms of 24 kHz audio). */
const chunk = () => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "A".repeat(19_200) } }], role: "model" } } });
const chunkBytes = new TextEncoder().encode(JSON.stringify(chunk())).byteLength;

function setup(model: string | null = "gemini-3.8-live") {
  let now = 1_000_000;
  const timers: { at: number; resolve: () => void }[] = [];
  const first = new FakeSocket();
  const opened: FakeSocket[] = [];
  const toClient: Record<string, unknown>[] = [];
  const usage: { id: string; measures: Record<string, number> }[] = [];
  const logs: Record<string, unknown>[] = [];
  let cuts = 0;
  let gone = 0;
  const upstream = new GeminiUpstream({
    socket: first,
    open: async () => {
      const socket = new FakeSocket();
      opened.push(socket);
      return socket;
    },
    model,
    now: () => now,
    wait: (ms) => new Promise<void>((resolve) => timers.push({ at: now + ms, resolve })),
    events: {
      frame: (data) => toClient.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<string, unknown>),
      usage: (event) => usage.push(event),
      cut: () => void (cuts += 1),
      gone: () => void (gone += 1),
      log: (event) => logs.push(event),
    },
  });
  /** Moves the clock, and lets the timers that came due run. */
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((one) => one.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.resolve();
    }
    for (let step = 0; step < 50; step += 1) await Promise.resolve();
  };
  /** The client's setup goes out, and the first connection is set up and resumable. */
  const started = (handle = "h1") => {
    upstream.send(JSON.stringify({ setup: { model: "models/gemini-cheap", generationConfig: { responseModalities: ["AUDIO"] } } }));
    first.emit({ setupComplete: {} });
    first.emit({ sessionResumptionUpdate: { newHandle: handle, resumable: true } });
  };
  return { upstream, first, opened, toClient, usage, logs, advance, started, cuts: () => cuts, gone: () => gone };
}

describe("Gemini Live's adapter (step 9d)", () => {
  it("reads one turn's usage by modality: text at its rate, audio apart, thinking as output text", () => {
    expect(geminiMeasures(USAGE)).toEqual({
      input_tokens: 638,
      output_tokens: 99,
      input_split: 1,
      output_split: 1,
      input_audio_tokens: 295,
      output_audio_tokens: 45,
    });
    // No breakdown: every token of that side is unknown, billed at the model's highest rate.
    expect(geminiMeasures({ promptTokenCount: 100, responseTokenCount: 20 })).toMatchObject({ input_tokens: 100, input_unknown_tokens: 100, output_unknown_tokens: 20 });
  });

  it("reads usage and answers from binary frames, and never parses an answer's audio chunk", () => {
    const adapter = adapterFor("gemini");
    const bytes = (message: unknown) => new TextEncoder().encode(JSON.stringify(message)).buffer as ArrayBuffer;
    const audio = bytes(chunk());
    expect(adapter.turn(audio)).toBe("open");
    expect(geminiMessage(audio)).toEqual({ serverContent: { modelTurn: true } });
    expect(adapter.read(audio)).toBeNull();
    const done = bytes({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(adapter.turn(done)).toBe("done");
    expect(adapter.read(done)?.measures).toMatchObject({ input_tokens: 638, output_tokens: 99 });
    // The last audio chunk can carry the end of the answer: then it is parsed.
    const last = bytes({ ...chunk(), usageMetadata: USAGE, serverContent: { ...chunk().serverContent, turnComplete: true } });
    expect(adapter.turn(last)).toBe("done");
    expect(adapter.read(last)).not.toBeNull();
  });
});

describe("Gemini Live's upstream: the setup (step 9d)", () => {
  it("locks the model, turns compression on, and replaces the app's resumption fields", () => {
    const s = setup();
    s.upstream.send(JSON.stringify({ setup: { model: "models/gemini-cheap", sessionResumption: { handle: "the-apps" }, session_resumption: { handle: "x" } } }));
    expect(s.first.messages()).toEqual([{ setup: { model: "models/gemini-3.8-live", contextWindowCompression: { slidingWindow: {} }, sessionResumption: {} } }]);
    // A second setup is dropped: Gemini takes one per connection.
    s.upstream.send(JSON.stringify({ setup: { model: "models/other" } }));
    expect(s.first.sent).toHaveLength(1);
  });

  it("keeps the app's own compression settings, and reads a setup sent as bytes", () => {
    const s = setup();
    const setupBytes = new TextEncoder().encode(JSON.stringify({ setup: { contextWindowCompression: { triggerTokens: 9000 } } })).buffer as ArrayBuffer;
    s.upstream.send(setupBytes);
    expect(s.first.messages()[0]).toEqual({ setup: { contextWindowCompression: { triggerTokens: 9000 }, model: "models/gemini-3.8-live", sessionResumption: {} } });
  });

  it("hides the resumption handles and goAway from the client, and passes everything else", () => {
    const s = setup();
    s.started();
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.toClient).toEqual([{ setupComplete: {} }, { serverContent: { turnComplete: true }, usageMetadata: USAGE }]);
  });
});

describe("Gemini Live's upstream: the swap (step 9d; T19)", () => {
  it("after goAway at a quiet moment: closes the old connection first, resumes with the handle, and sends the waiting frames in order", async () => {
    const s = setup();
    s.started("h2");
    s.upstream.send(JSON.stringify({ realtimeInput: { text: "before" } }));
    s.first.emit({ goAway: { timeLeft: "50s" } });
    expect(s.first.closedWith?.code).toBe(1000);
    // Frames that come during the swap wait; the old connection got nothing more.
    s.upstream.send(JSON.stringify({ realtimeInput: { text: "during" } }));
    expect(s.first.messages().map((message) => Object.keys(message)[0])).toEqual(["setup", "realtimeInput"]);
    expect(s.opened).toHaveLength(0);
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    const next = s.opened[0] as FakeSocket;
    expect(next.messages()).toEqual([{ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, contextWindowCompression: { slidingWindow: {} }, sessionResumption: { handle: "h2" } } }]);
    next.emit({ setupComplete: {} });
    // The waiting frame goes on; the one sent before the swap is never sent again.
    expect(next.messages().slice(1)).toEqual([{ realtimeInput: { text: "during" } }]);
    // The client saw one setupComplete, and no goAway.
    expect(s.toClient).toEqual([{ setupComplete: {} }]);
    s.upstream.send(JSON.stringify({ realtimeInput: { text: "after" } }));
    expect(next.messages().at(-1)).toEqual({ realtimeInput: { text: "after" } });
    expect(s.cuts()).toBe(0);
    expect(s.gone()).toBe(0);
  });

  it("waits for an answer to finish before it swaps", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "50s" } });
    expect(s.first.closedWith).toBeNull();
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.first.closedWith?.code).toBe(1000);
    expect(s.cuts()).toBe(0);
  });

  it("waits while the user speaks, and for the answer that follows, then swaps", () => {
    const s = setup();
    s.started();
    s.upstream.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    s.first.emit({ goAway: { timeLeft: "50s" } });
    expect(s.first.closedWith).toBeNull();
    s.upstream.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    // The end of speech went to the connection that heard its start, and its answer comes there.
    expect(s.first.messages().at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    expect(s.first.closedWith).toBeNull();
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.first.closedWith?.code).toBe(1000);
  });

  it("waits for the answer to a turn the client just sent, so the turn is never sent to a connection about to close", () => {
    const s = setup();
    s.started();
    s.upstream.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "hi" }] }], turnComplete: true } }));
    s.first.emit({ goAway: { timeLeft: "50s" } });
    expect(s.first.closedWith).toBeNull();
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.first.closedWith?.code).toBe(1000);
    expect(s.cuts()).toBe(0);
  });

  it("waits for every answer asked for: a second turn sent before the first answer finished keeps the swap waiting", () => {
    const s = setup();
    s.started();
    const turn = JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "hi" }] }], turnComplete: true } });
    s.upstream.send(turn);
    s.upstream.send(turn);
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.first.closedWith).toBeNull();
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.first.closedWith?.code).toBe(1000);
  });

  it("swaps at the deadline when the answer runs on, and bills the cut answer from the audio forwarded, as an estimate", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "50s" } });
    await s.advance(50_000 - GOAWAY_MARGIN_MS - 1);
    expect(s.first.closedWith).toBeNull();
    await s.advance(1);
    expect(s.first.closedWith?.code).toBe(1000);
    const tokens = Math.ceil((2 * chunkBytes) / BYTES_PER_ESTIMATED_TOKEN);
    expect(s.usage).toEqual([{ id: expect.any(String), measures: { output_tokens: tokens, output_split: 1, output_audio_tokens: tokens, estimated_tokens: tokens } }]);
    expect(s.cuts()).toBe(1);
  });

  it("tries a refused resume again every 250 ms, and goes on once one is set up", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    // Gemini still sees the old connection: the new one is closed before it is set up (T19: 1008).
    (s.opened[0] as FakeSocket).fireClose(1008);
    await s.advance(RESUME_RETRY_MS - 1);
    expect(s.opened).toHaveLength(1);
    await s.advance(1);
    expect(s.opened).toHaveLength(2);
    (s.opened[1] as FakeSocket).emit({ setupComplete: {} });
    expect(s.gone()).toBe(0);
    s.upstream.send(JSON.stringify({ realtimeInput: { text: "after" } }));
    expect((s.opened[1] as FakeSocket).messages().at(-1)).toEqual({ realtimeInput: { text: "after" } });
  });

  it("opens the new connection anyway when the old one's close never comes", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    await s.advance(OLD_CLOSE_WAIT_MS);
    expect(s.opened).toHaveLength(1);
  });

  it("ends the session when no resume is set up in time", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    await s.advance(RESUME_LIMIT_MS);
    expect(s.gone()).toBe(1);
    expect(s.logs).toContainEqual(expect.objectContaining({ level: "warn", message: "relay_gemini_resume_failed" }));
    // Nothing more is tried, and a late setup changes nothing.
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    s.upstream.send(JSON.stringify({ realtimeInput: { text: "late" } }));
    expect((s.opened[0] as FakeSocket).messages()).toHaveLength(1);
  });

  it("resumes after an unexpected close, and bills the answer it cut as an estimate (T19: gemini-3.8-live's 1011)", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.fireClose(1011);
    expect(s.cuts()).toBe(1);
    expect(s.usage[0]?.measures.estimated_tokens).toBeGreaterThan(0);
    await until(() => s.opened.length === 1);
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    expect(s.gone()).toBe(0);
  });

  it("ends with the connection when there is no handle to resume with", () => {
    const s = setup();
    s.upstream.send(JSON.stringify({ setup: {} }));
    s.first.emit({ setupComplete: {} });
    s.first.fireClose(1011);
    expect(s.gone()).toBe(1);
    expect(s.opened).toHaveLength(0);
  });

  it("still counts the usage an old connection reports while it closes, and forwards nothing of it", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.usage).toHaveLength(1);
    expect(s.toClient).toEqual([{ setupComplete: {} }]);
  });

  it("closes every connection when the session ends, and resumes nothing after", async () => {
    const s = setup();
    s.started();
    s.upstream.close(1000, "session ended");
    expect(s.first.closedWith).toEqual({ code: 1000, reason: "session ended" });
    s.first.fireClose(1000);
    await s.advance(RESUME_LIMIT_MS);
    expect(s.opened).toHaveLength(0);
    expect(s.gone()).toBe(0);
  });
});

describe("a Gemini Live slice's price (step 9d)", () => {
  const price = () => {
    const resolved = billingForCharge(priceSources({ type: "gemini", rates_json: null }), "gemini-3.8-live");
    if (resolved === null) throw new Error("gemini-3.8-live has no list price");
    return resolved;
  };

  it("bills audio at its own rate, text at the text rate, and the thinking at the output text rate", () => {
    // 300 text + 700 audio in at $0.75 and $3 a million; 100 audio out at $12, 50 thinking at $4.50.
    const priced = priceSlice({ input_tokens: 1000, input_split: 1, input_audio_tokens: 700, output_tokens: 150, output_split: 1, output_audio_tokens: 100 }, price());
    expect(priced.costNano).toBe(300 * 750 + 700 * 3_000 + 100 * 12_000 + 50 * 4_500);
    expect(priced.estimated).toBe(false);
  });

  it("bills tokens no breakdown covered at the model's highest rate, and an estimate as one", () => {
    const unknown = priceSlice({ input_tokens: 100, input_split: 1, input_unknown_tokens: 100, output_tokens: 0 }, price());
    expect(unknown.costNano).toBe(100 * 3_000);
    const estimated = priceSlice({ output_tokens: 10, output_split: 1, output_audio_tokens: 10, estimated_tokens: 10 }, price());
    expect(estimated).toMatchObject({ costNano: 10 * 12_000, estimated: true });
  });
});
