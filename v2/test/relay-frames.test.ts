/**
 * What a live session does with its frames (`relay/src/frames.js`; plan
 * section 5.2): the frame limits, the relay's own messages only for a client
 * that asked, the heartbeat, and "client too slow". The clock is the test's.
 */
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_TIMEOUT_MS,
  MAX_CLIENT_FRAME,
  MAX_CLIENT_FRAMES_PER_SECOND,
  SessionFrames,
  SLOW_CLIENT_MS,
  START_QUEUE_BYTES,
  START_QUEUE_FRAMES,
  providerFrame,
  StartQueue,
} from "../relay/src/frames.js";

function frames(options: { relayMessages?: boolean; clientHook?: (data: string | ArrayBuffer) => string | null } = {}) {
  let now = 1_000_000;
  const state = new SessionFrames({ now: () => now, relayMessages: options.relayMessages ?? true, ...(options.clientHook === undefined ? {} : { clientHook: options.clientHook }) });
  return { state, tick: (ms: number) => (now += ms), now: () => now };
}

/** One second of audio from the provider, in 20 frames of 3,200 characters. */
function oneSecondOfAudio(f: ReturnType<typeof frames>) {
  for (let frame = 0; frame < 20; frame += 1) {
    f.state.toClient("x".repeat(3_200));
    f.tick(50);
  }
}

describe("a client's frames", () => {
  it("are forwarded, and a frame too large or too many in a second end the session", () => {
    const f = frames();
    expect(f.state.fromClient("hello")).toEqual({ kind: "forward" });
    expect(f.state.fromClient(new ArrayBuffer(16))).toEqual({ kind: "forward" });
    expect(f.state.fromClient("x".repeat(MAX_CLIENT_FRAME + 1))).toEqual({ kind: "end", reason: "error", closeCode: 1009, closeReason: "frame_too_large" });

    const g = frames();
    for (let frame = 0; frame < MAX_CLIENT_FRAMES_PER_SECOND; frame += 1) expect(g.state.fromClient("a").kind).toBe("forward");
    expect(g.state.fromClient("a")).toEqual({ kind: "end", reason: "error", closeCode: 1008, closeReason: "rate_limited" });
    // A new second starts a new count.
    const h = frames();
    for (let frame = 0; frame < MAX_CLIENT_FRAMES_PER_SECOND; frame += 1) h.state.fromClient("a");
    h.tick(1_000);
    expect(h.state.fromClient("a").kind).toBe("forward");
  });

  it("go through the adapter's hook: a refusal ends the session with its code", () => {
    const f = frames({ clientHook: (data) => (data === "change the model" ? "model_locked" : null) });
    expect(f.state.fromClient("fine").kind).toBe("forward");
    expect(f.state.fromClient("change the model")).toEqual({ kind: "end", reason: "error", closeCode: 1008, closeReason: "model_locked" });
  });

  it("include the relay's own messages only for a client that asked: answered, never forwarded", () => {
    const sdk = frames({ relayMessages: true });
    expect(sdk.state.fromClient(JSON.stringify({ type: "agw.heartbeat" }))).toEqual({ kind: "answer", message: JSON.stringify({ type: "agw.heartbeat" }) });
    expect(sdk.state.fromClient(JSON.stringify({ type: "agw.received", bytes: 10 }))).toEqual({ kind: "drop" });
    expect(sdk.state.fromClient('{"type":"agw.unknown"}')).toEqual({ kind: "drop" });
    expect(sdk.state.fromClient('{"type":"agw.')).toEqual({ kind: "drop" });
    // An official SDK asked for none: its frames are the provider's, even one that looks like ours.
    const official = frames({ relayMessages: false });
    expect(official.state.fromClient(JSON.stringify({ type: "agw.heartbeat" }))).toEqual({ kind: "forward" });
  });
});

describe("a client that falls behind", () => {
  it("is ended with client_too_slow once it is about 10 s of audio behind, by its own reports", () => {
    const f = frames();
    // It reports keeping up for a while.
    for (let second = 0; second < 5; second += 1) {
      oneSecondOfAudio(f);
      expect(f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: f.state.sent }))).toEqual({ kind: "drop" });
    }
    // Then it stops reading, but keeps sending reports of what it got.
    const stuckAt = f.state.sent;
    let verdict = f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: stuckAt }));
    let seconds = 0;
    while (verdict.kind !== "end" && seconds < 60) {
      oneSecondOfAudio(f);
      seconds += 1;
      verdict = f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: stuckAt }));
    }
    expect(verdict).toEqual({ kind: "end", reason: "client_too_slow", closeCode: 4000, closeReason: "client_too_slow" });
    // Ended about 10 s in, not at once and not much later.
    expect(seconds).toBeGreaterThanOrEqual(SLOW_CLIENT_MS / 1_000);
    expect(seconds).toBeLessThanOrEqual(SLOW_CLIENT_MS / 1_000 + 2);
  });

  it("is found by the tick too, when its reports stop", () => {
    const f = frames();
    oneSecondOfAudio(f);
    f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: f.state.sent }));
    for (let second = 0; second < 12; second += 1) oneSecondOfAudio(f);
    expect(f.state.check(f.now())).toBe("client_too_slow");
  });

  it("is never ended for falling behind when it sends no reports: an official SDK is bounded by the cap", () => {
    const f = frames({ relayMessages: false });
    for (let second = 0; second < 30; second += 1) {
      oneSecondOfAudio(f);
      f.state.fromClient("still talking");
    }
    expect(f.state.check(f.now())).toBeNull();
  });

  it("keeps about one mark a second, so a long session holds little", () => {
    const f = frames();
    for (let second = 0; second < 120; second += 1) oneSecondOfAudio(f);
    expect(f.state.marks.length).toBeLessThanOrEqual(121);
    f.state.received(f.state.sent);
    expect(f.state.marks).toEqual([]);
  });
});

describe("the heartbeat", () => {
  it("ends a session whose client sent nothing for 90 s", () => {
    const f = frames();
    f.tick(HEARTBEAT_TIMEOUT_MS - 1);
    expect(f.state.check(f.now())).toBeNull();
    f.state.fromClient(JSON.stringify({ type: "agw.heartbeat" }));
    f.tick(HEARTBEAT_TIMEOUT_MS - 1);
    expect(f.state.check(f.now())).toBeNull();
    f.tick(1);
    expect(f.state.check(f.now())).toBe("heartbeat_timeout");
  });

  it("does not cut a receive-only official SDK while the provider still sends to it", () => {
    const f = frames({ relayMessages: false });
    for (let second = 0; second < 120; second += 1) oneSecondOfAudio(f);
    expect(f.state.check(f.now())).toBeNull();
    // Both quiet: gone.
    f.tick(HEARTBEAT_TIMEOUT_MS);
    expect(f.state.check(f.now())).toBe("heartbeat_timeout");
  });

  it("counts provider frames for our SDK not at all: it always sends, so its silence means it is gone", () => {
    const f = frames({ relayMessages: true });
    for (let second = 0; second < 95; second += 1) oneSecondOfAudio(f);
    expect(f.state.check(f.now())).toBe("heartbeat_timeout");
  });
});

describe("reports and the start (Sol, #260 round 1)", () => {
  it("ignores a report higher than what was sent, or not a whole number: it can't switch the check off", () => {
    for (const bad of [Number.MAX_SAFE_INTEGER, 1e30, 1.5, -1]) {
      const f = frames();
      oneSecondOfAudio(f);
      f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: bad }));
      for (let second = 0; second < 12; second += 1) oneSecondOfAudio(f);
      expect(f.state.check(f.now()), String(bad)).toBe("client_too_slow");
    }
  });

  it("catches our SDK stalling before its first report: it is tracked from the first provider frame", () => {
    const f = frames({ relayMessages: true });
    let verdict: ReturnType<SessionFrames["fromClient"]> = { kind: "forward" };
    for (let second = 0; second < 12 && verdict.kind !== "end"; second += 1) {
      oneSecondOfAudio(f);
      verdict = f.state.fromClient(JSON.stringify({ type: "agw.received", bytes: 0 }));
    }
    expect(verdict).toEqual({ kind: "end", reason: "client_too_slow", closeCode: 4000, closeReason: "client_too_slow" });
  });
});

describe("the start queue", () => {
  it("holds frames in order, and overflows on too many or too many bytes, dropping what it held", () => {
    const byCount = new StartQueue();
    for (let frame = 0; frame < START_QUEUE_FRAMES; frame += 1) expect(byCount.push("a")).toBe(true);
    expect(byCount.push("a")).toBe(false);
    expect(byCount.overflowed).toBe(true);
    expect(byCount.drain()).toEqual([]);

    // Text is charged two bytes per character, what it takes in memory (Sol, #260 round 2).
    const bySize = new StartQueue();
    const chunk = "x".repeat(256 * 1024);
    let pushed = 0;
    while (bySize.push(chunk)) pushed += 1;
    expect(pushed).toBe(Math.floor(START_QUEUE_BYTES / (chunk.length * 2)));
    const binary = new StartQueue();
    let binaryPushed = 0;
    while (binary.push(new ArrayBuffer(256 * 1024))) binaryPushed += 1;
    expect(binaryPushed).toBe(Math.floor(START_QUEUE_BYTES / (256 * 1024)));
    expect(bySize.overflowed).toBe(true);
    expect(bySize.bytes).toBe(0);
    // Nothing more is held once it overflowed.
    expect(bySize.push("a")).toBe(false);

    const ordered = new StartQueue();
    ordered.push("first");
    ordered.push(new ArrayBuffer(2));
    ordered.push("third");
    expect(ordered.drain().map((data) => (typeof data === "string" ? data : data.byteLength))).toEqual(["first", 2, "third"]);
    expect(ordered.drain()).toEqual([]);
  });
});

describe("provider frames during the start (Sol, #260 round 2)", () => {
  it("are held until the session started, overflow without closing anything, then go through forward", () => {
    const forwarded: (string | ArrayBuffer)[] = [];
    const closes: string[] = [];
    const call = { forward: null as ((data: string | ArrayBuffer) => void) | null, pending: new StartQueue(), close: (code: number, reason: string) => closes.push(`${code} ${reason}`) };
    for (let frame = 0; frame < START_QUEUE_FRAMES + 50; frame += 1) providerFrame(call, `f${frame}`);
    // Overflowed: everything held is dropped, nothing is closed here, and the owning start ends the session.
    expect(call.pending.overflowed).toBe(true);
    expect(closes).toEqual([]);
    expect(call.pending.drain()).toEqual([]);
    const fresh = { forward: null as ((data: string | ArrayBuffer) => void) | null, pending: new StartQueue() };
    providerFrame(fresh, "early");
    fresh.forward = (data) => forwarded.push(data);
    providerFrame(fresh, "late");
    expect(fresh.pending.drain()).toEqual(["early"]);
    expect(forwarded).toEqual(["late"]);
  });
});
