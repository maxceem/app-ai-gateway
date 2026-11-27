/**
 * Gemini Live through the relay (step 9d; T4, T19): its adapter, the relay's
 * own upstream with its resumption and swaps (`relay/src/gemini.js`), and
 * the price of a slice by modality. The upstream runs against stand-in
 * sockets and a timer the test moves: no real wait.
 */
import { describe, expect, it } from "vitest";
import { adapterFor, geminiMeasures, geminiMessage } from "../relay/src/adapters.js";
import { BYTES_PER_ESTIMATED_TOKEN, GeminiUpstream, GOAWAY_MARGIN_MS, OLD_CLOSE_WAIT_MS, QUICK_CLOSE_MS, RESUME_LIMIT_MS, RESUME_RETRY_MS } from "../relay/src/gemini.js";
import { billingForCharge, priceSources } from "../src/pricing/billability.ts";
import { priceSlice } from "../src/relay/checkpoint.ts";
import { Session } from "../relay/src/index.js";
import { SessionCore } from "../relay/src/start.js";
import { MemoryStore, ticketFor, until } from "./relay-stand-ins.ts";

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
  fireClose(code = 1000, reason = ""): void {
    for (const listener of this.listeners.close) listener({ code, reason } as never);
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

function setup(model: string | null = "gemini-3.8-live", deadline = Infinity) {
  let now = 1_000_000;
  const timers: { at: number; resolve: () => void }[] = [];
  const first = new FakeSocket();
  const opened: FakeSocket[] = [];
  const toClient: Record<string, unknown>[] = [];
  const usage: { id: string; measures: Record<string, number> }[] = [];
  const logs: Record<string, unknown>[] = [];
  let cuts = 0;
  let gone = 0;
  /** Whether the session object forwards frames (false: it is closing, and throws them away). */
  const forwarding = { on: true };
  /** A test's way to hold a resume's handshake until it lets it finish. */
  const handshake: { hold: Promise<void> | null } = { hold: null };
  let capped = 0;
  const refused: string[] = [];
  const endedWith: { code: number; reason: string }[] = [];
  const upstream = new GeminiUpstream({
    socket: first,
    open: async () => {
      if (handshake.hold !== null) await handshake.hold;
      const socket = new FakeSocket();
      opened.push(socket);
      return socket;
    },
    model,
    deadline,
    now: () => now,
    wait: (ms) => new Promise<void>((resolve) => timers.push({ at: now + ms, resolve })),
    events: {
      frame: (data) => {
        toClient.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<string, unknown>);
        return forwarding.on;
      },
      usage: (event) => usage.push(event),
      cut: () => void (cuts += 1),
      gone: () => void (gone += 1),
      capped: () => void (capped += 1),
      refuse: (code) => void refused.push(code),
      ended: (code, reason) => void endedWith.push({ code, reason }),
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
  return { upstream, first, opened, toClient, usage, logs, refused, endedWith, forwarding, handshake, advance, started, cuts: () => cuts, gone: () => gone, capped: () => capped };
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

  it("reads the first message whole: a setup with leading spacing or other keys is still rewritten (the model lock)", () => {
    const s = setup();
    s.upstream.send(`${" ".repeat(64)}\n{"other": 1, "setup": {"model": "models/gemini-cheap", "sessionResumption": {"handle": "x"}}}`);
    expect(s.first.messages()).toEqual([{ setup: { model: "models/gemini-3.8-live", contextWindowCompression: { slidingWindow: {} }, sessionResumption: {} } }]);
  });

  it("ends the session when the first message is not a setup, and sends nothing upstream", () => {
    const s = setup();
    s.upstream.send(JSON.stringify({ clientContent: { turns: [] } }));
    expect(s.refused).toEqual(["setup_required"]);
    expect(s.first.sent).toHaveLength(0);
    s.upstream.send("not json");
    expect(s.refused).toEqual(["setup_required", "setup_required"]);
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
  const handle = (socket: FakeSocket, newHandle: string) => socket.emit({ sessionResumptionUpdate: { newHandle, resumable: true } });
  const text = (said: string) => JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: said }] }], turnComplete: true } });
  const audio = JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AAAA" } } });

  it("after goAway, swaps on Gemini's next handle at a quiet moment: the old connection closes first, the new one resumes with that handle, and waiting frames go on in order", async () => {
    const s = setup();
    s.started("h1");
    s.upstream.send(audio);
    s.first.emit({ goAway: { timeLeft: "50s" } });
    // goAway alone changes nothing: the swap waits for the next handle.
    expect(s.first.closedWith).toBeNull();
    handle(s.first, "h2");
    expect(s.first.closedWith?.code).toBe(1000);
    s.upstream.send(text("during"));
    expect(s.first.messages().map((message) => Object.keys(message)[0])).toEqual(["setup", "realtimeInput"]);
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    const next = s.opened[0] as FakeSocket;
    expect(next.messages()).toEqual([{ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, contextWindowCompression: { slidingWindow: {} }, sessionResumption: { handle: "h2" } } }]);
    next.emit({ setupComplete: {} });
    expect(next.messages().slice(1)).toEqual([JSON.parse(text("during"))]);
    expect(s.toClient).toEqual([{ setupComplete: {} }]);
    expect(s.cuts()).toBe(0);
    expect(s.gone()).toBe(0);
  });

  it("does not swap on a handle while an answer runs, while the user speaks, or after a client turn that has no answer yet", () => {
    const answering = setup();
    answering.started();
    answering.first.emit(chunk());
    answering.first.emit({ goAway: { timeLeft: "50s" } });
    handle(answering.first, "h2");
    expect(answering.first.closedWith).toBeNull();
    const speaking = setup();
    speaking.started();
    speaking.first.emit({ voiceActivity: { type: "ACTIVITY_START" } });
    speaking.first.emit({ goAway: { timeLeft: "50s" } });
    handle(speaking.first, "h2");
    expect(speaking.first.closedWith).toBeNull();
    const asked = setup();
    asked.started();
    asked.upstream.send(text("hi"));
    asked.first.emit({ goAway: { timeLeft: "50s" } });
    handle(asked.first, "h2");
    expect(asked.first.closedWith).toBeNull();
    // Gemini's end of speech asks too.
    const spoke = setup();
    spoke.started();
    spoke.first.emit({ voiceActivity: { type: "ACTIVITY_START" } });
    spoke.first.emit({ voiceActivity: { type: "ACTIVITY_END" } });
    spoke.first.emit({ goAway: { timeLeft: "50s" } });
    handle(spoke.first, "h2");
    expect(spoke.first.closedWith).toBeNull();
  });

  it("after a turnComplete, resumes with the handle that came after it, never one from before (T19, run I)", async () => {
    const s = setup();
    s.started("h1");
    s.upstream.send(text("tell me a story"));
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    // Not at the turnComplete itself: the handle Gemini has then would lose the answer.
    expect(s.first.closedWith).toBeNull();
    handle(s.first, "h-after");
    expect(s.first.closedWith?.code).toBe(1000);
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    expect((s.opened[0] as FakeSocket).messages()[0]).toMatchObject({ setup: { sessionResumption: { handle: "h-after" } } });
  });

  it("never swaps on an update that brings no handle", () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.emit({ sessionResumptionUpdate: { resumable: false } });
    s.first.emit({ sessionResumptionUpdate: {} });
    expect(s.first.closedWith).toBeNull();
  });

  it("does not swap after a barge-in: the user speaks, the old answer ends, then a handle comes", () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "50s" } });
    s.first.emit({ voiceActivity: { type: "ACTIVITY_START" } });
    s.first.emit({ serverContent: { interrupted: true } });
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    handle(s.first, "h2");
    expect(s.first.closedWith).toBeNull();
  });

  it("counts realtime media in either spelling as no request: a snake_case audio frame leaves the next handle free to swap", () => {
    const s = setup();
    s.started();
    s.upstream.send(JSON.stringify({ realtime_input: { media_chunks: [{ mime_type: "audio/pcm", data: "AAAA" }] } }));
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
    expect(s.first.closedWith?.code).toBe(1000);
  });

  it("with no handle after goAway, swaps at the deadline, and bills an answer it cuts from the audio forwarded, once the old connection closed", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "50s" } });
    await s.advance(50_000 - GOAWAY_MARGIN_MS - 1);
    expect(s.first.closedWith).toBeNull();
    await s.advance(1);
    expect(s.first.closedWith?.code).toBe(1000);
    expect(s.cuts()).toBe(1);
    // The estimate waits for the old connection's close: its real usage could still come.
    expect(s.usage).toEqual([]);
    s.first.fireClose(1000);
    const tokens = Math.ceil((2 * chunkBytes) / BYTES_PER_ESTIMATED_TOKEN);
    await until(() => s.usage.length === 1);
    expect(s.usage).toEqual([{ id: expect.any(String), measures: { output_tokens: tokens, output_split: 1, output_audio_tokens: tokens, estimated_tokens: tokens } }]);
  });

  it("bills a cut answer's real usage instead of its estimate when the old connection reports it while it closes", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "10s" } });
    await s.advance(0);
    expect(s.first.closedWith?.code).toBe(1000);
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    expect(s.usage).toEqual([{ id: expect.any(String), measures: expect.objectContaining({ input_tokens: 638, output_tokens: 99 }) }]);
    expect(s.usage[0]?.measures.estimated_tokens).toBeUndefined();
  });

  it("stops reading the old connection when its close wait ends: usage it sends after that never adds to the estimate (Sol, #269 round 2)", async () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.first.emit({ goAway: { timeLeft: "10s" } });
    await s.advance(0);
    await s.advance(OLD_CLOSE_WAIT_MS);
    await until(() => s.usage.length === 1);
    expect(s.usage[0]?.measures.estimated_tokens).toBeGreaterThan(0);
    s.first.emit({ serverContent: { turnComplete: true }, usageMetadata: USAGE });
    expect(s.usage).toHaveLength(1);
  });

  it("estimates a cut answer from what reached the client only, not audio thrown away while the session closes (Sol, #269 round 2)", () => {
    const s = setup();
    s.started();
    s.first.emit(chunk());
    s.forwarding.on = false;
    s.first.emit(chunk());
    s.first.emit(chunk());
    expect(s.upstream.estimate()?.measures.estimated_tokens).toBe(Math.ceil(chunkBytes / BYTES_PER_ESTIMATED_TOKEN));
  });

  it("estimates a cut tool call as nothing: only an answer's audio is billed as audio (Sol, #269 round 3)", () => {
    const s = setup();
    s.started();
    s.first.emit({ toolCall: { functionCalls: [{ id: "f1", name: "weather", args: { city: "x".repeat(8_000) } }] } });
    expect(s.upstream.estimate()).toBeNull();
    expect(s.cuts()).toBe(1);
  });

  it("counts a frame that waited in a swap when it is sent: it asks on the new connection", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
    s.upstream.send(text("during"));
    expect(s.upstream.asked).toBe(false);
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    expect(s.upstream.asked).toBe(true);
  });

  it("opens no resume past the cap: a handshake that ends after it is closed, and no setup goes (Sol, #269 round 2)", async () => {
    const s = setup("gemini-3.8-live", 1_000_000 + QUICK_CLOSE_MS + 1_000);
    s.started();
    await s.advance(QUICK_CLOSE_MS);
    let release: () => void = () => undefined;
    s.handshake.hold = new Promise<void>((resolve) => (release = resolve));
    s.first.fireClose(1011);
    await s.advance(500);
    await s.advance(1_000);
    release();
    await until(() => s.opened.length === 1);
    await s.advance(0);
    expect((s.opened[0] as FakeSocket).closedWith?.code).toBe(1000);
    expect((s.opened[0] as FakeSocket).sent).toHaveLength(0);
    expect(s.capped()).toBe(1);
  });

  it("goes on past no deadline: a swap set up after the session's cap sends nothing and ends it at its cap; one that starts past the cap opens nothing", async () => {
    const s = setup("gemini-3.8-live", 1_000_000 + 5_000);
    s.started();
    s.first.emit({ goAway: { timeLeft: "10s" } });
    await s.advance(0);
    s.upstream.send(text("late"));
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    await s.advance(5_000);
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    expect(s.capped()).toBe(1);
    expect((s.opened[0] as FakeSocket).messages()).toHaveLength(1);
    const t = setup("gemini-3.8-live", 1_000_000 + QUICK_CLOSE_MS);
    t.started();
    await t.advance(QUICK_CLOSE_MS);
    t.first.fireClose(1011);
    await t.advance(0);
    expect(t.opened).toHaveLength(0);
    expect(t.capped()).toBe(1);
  });

  it("tries a refused resume again every 250 ms, and goes on once one is set up", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
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
    s.upstream.send(text("after"));
    expect((s.opened[1] as FakeSocket).messages().at(-1)).toEqual(JSON.parse(text("after")));
  });

  it("opens the new connection anyway when the old one's close never comes", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
    await s.advance(OLD_CLOSE_WAIT_MS);
    expect(s.opened).toHaveLength(1);
  });

  it("ends the session when no resume is set up in time", async () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
    s.first.fireClose(1000);
    await until(() => s.opened.length === 1);
    await s.advance(RESUME_LIMIT_MS);
    expect(s.gone()).toBe(1);
    expect(s.logs).toContainEqual(expect.objectContaining({ level: "warn", message: "relay_gemini_resume_failed" }));
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    s.upstream.send(text("late"));
    expect((s.opened[0] as FakeSocket).messages()).toHaveLength(1);
  });

  it("resumes after an unexpected close, and bills the answer it cut as an estimate (T19: gemini-3.8-live's 1011)", async () => {
    const s = setup();
    s.started();
    await s.advance(QUICK_CLOSE_MS);
    s.first.emit(chunk());
    s.first.fireClose(1011);
    expect(s.cuts()).toBe(1);
    expect(s.usage[0]?.measures.estimated_tokens).toBeGreaterThan(0);
    await until(() => s.opened.length === 1);
    (s.opened[0] as FakeSocket).emit({ setupComplete: {} });
    expect(s.gone()).toBe(0);
  });

  it("does not resume a connection Gemini closed right after its setup: the session ends with Gemini's code and reason (Fable, #269 round 1)", async () => {
    const s = setup();
    s.started();
    s.first.fireClose(1007, "Request contains an invalid argument.");
    expect(s.endedWith).toEqual([{ code: 1007, reason: "Request contains an invalid argument." }]);
    await s.advance(OLD_CLOSE_WAIT_MS);
    expect(s.opened).toHaveLength(0);
    // The same after a resume: the new connection's own setup counts.
    const t = setup();
    t.started();
    await t.advance(QUICK_CLOSE_MS);
    t.first.fireClose(1011);
    await until(() => t.opened.length === 1);
    (t.opened[0] as FakeSocket).emit({ setupComplete: {} });
    (t.opened[0] as FakeSocket).fireClose(1007, "bad");
    expect(t.endedWith).toEqual([{ code: 1007, reason: "bad" }]);
    expect(t.opened).toHaveLength(1);
  });

  it("ends with the connection when there is no handle to resume with", async () => {
    const s = setup();
    s.upstream.send(JSON.stringify({ setup: {} }));
    s.first.emit({ setupComplete: {} });
    await s.advance(QUICK_CLOSE_MS);
    s.first.fireClose(1011);
    expect(s.gone()).toBe(1);
    expect(s.opened).toHaveLength(0);
  });

  it("still counts the usage an old connection reports while it closes, and forwards nothing of it", () => {
    const s = setup();
    s.started();
    s.first.emit({ goAway: { timeLeft: "50s" } });
    handle(s.first, "h2");
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

describe("a Gemini Live session's own end (step 9d)", () => {
  it("bills the answer the cap cuts from its estimate, before the final slice (Sol, #269 round 1)", async () => {
    let now = 1_000_000;
    const store = new MemoryStore();
    const slices: { measures: Record<string, number>; gapMs: number }[] = [];
    const estimate = { id: "cut", measures: { output_tokens: 7, output_split: 1, output_audio_tokens: 7, estimated_tokens: 7 } };
    let asked = 0;
    const core = new SessionCore({
      store,
      now: () => now,
      log: () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "k", header: "x-goog-api-key", format: "{key}" }, target: "https://generativelanguage.googleapis.com/ws" }) as never },
      main: {
        open: async () => ({ deadline: now + 60_000, mode: "relayed", operation: "gemini.live.v1beta", checkpointIntervalMs: 60_000, version: 2, adapter: "gemini", model: "gemini-3.8-live" }) as never,
        checkpoint: async (_ticket: string, input: { slice: { measures: Record<string, number>; gapMs: number } | null }) => {
          if (input.slice !== null) slices.push(structuredClone(input.slice));
          return { decision: "continue", reasons: [], written: true } as never;
        },
        close: async () => ({ version: 2 }),
      },
      provider: { connect: async () => ({ callId: null, close: () => undefined, estimate: () => (asked++ === 0 ? estimate : null) }) },
      turnOpen: () => true,
    });
    const { text, ticket } = ticketFor(now, { providerType: "gemini", operation: "gemini.live.v1beta", model: "gemini-3.8-live", cap: 60_000 });
    expect((await core.start(text, ticket, { close: () => undefined })).ok).toBe(true);
    now += 60_000;
    await core.alarm();
    expect(asked).toBe(1);
    expect(slices.at(-1)?.measures).toMatchObject({ output_tokens: 7, output_audio_tokens: 7, estimated_tokens: 7 });
  });
});

describe("a relay that doesn't know a session's adapter (Sol, #269 round 5)", () => {
  it("ends the session before it calls the provider: an older relay never runs a newer gateway's session unread", async () => {
    const now = 1_000_000;
    const closes: { endReason: string }[] = [];
    let connects = 0;
    const core = new SessionCore({
      store: new MemoryStore(),
      now: () => now,
      log: () => undefined,
      vault: { sessionKey: async () => ({ key: { value: "k", header: "x-goog-api-key", format: "{key}" }, target: "https://provider.test/ws" }) as never },
      main: {
        open: async () => ({ deadline: now + 60_000, mode: "relayed", operation: "future.live", checkpointIntervalMs: 60_000, version: 2, adapter: "future-adapter" }) as never,
        checkpoint: async () => ({ decision: "continue", reasons: [], written: true }) as never,
        close: async (_ticket: string, input: { endReason: string }) => {
          closes.push({ endReason: input.endReason });
          return { version: 2 };
        },
      },
      provider: {
        connect: async () => {
          connects += 1;
          return { callId: null };
        },
      },
    });
    const { text, ticket } = ticketFor(now);
    expect(await core.start(text, ticket, { close: () => undefined })).toEqual({ ok: false, code: "adapter_unknown" });
    expect(connects).toBe(0);
    await until(() => closes.length === 1);
    expect(closes).toEqual([{ endReason: "error" }]);
  });
});

describe("the session object when Gemini closes a connection right after its setup (Sol, #269 round 5)", () => {
  /** The session object without its constructor, its core a stand-in. */
  function session(client: { closed: unknown[]; close: (code: number, reason: string) => void } | null) {
    const gone: unknown[] = [];
    const core = { providerGone: async (call: unknown) => void gone.push(call), turnDone: () => undefined, recordUsage: async () => undefined, sessionId: "ses_1", call: null as unknown };
    const object = Object.create(Session.prototype) as unknown as { geminiCall: (key: unknown, settings: unknown, socket: unknown) => { send: (data: string) => void } };
    (object as unknown as { core: unknown }).core = core;
    const socket = new FakeSocket();
    const call = object.geminiCall({ target: "https://g.test" }, { deadline: Date.now() + 60_000, model: "gemini-3.8-live" }, socket);
    core.call = call;
    (object as unknown as { live: unknown }).live = { client, call, held: { drain: () => [] } };
    call.send(JSON.stringify({ setup: {} }));
    socket.emit({ setupComplete: {} });
    socket.emit({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    return { call, socket, gone };
  }

  it("ends the session even when the client's link is down, so no client can come back to a dead call", () => {
    const s = session(null);
    s.socket.fireClose(1007, "bad frame");
    expect(s.gone).toEqual([s.call]);
  });

  it("closes an attached client with Gemini's code and reason, and ends the session", () => {
    const client = { closed: [] as unknown[], close(code: number, reason: string) { this.closed.push([code, reason]); } };
    const s = session(client);
    s.socket.fireClose(1007, "bad frame");
    expect(client.closed).toEqual([[1007, "bad frame"]]);
    expect(s.gone).toEqual([s.call]);
  });
});

