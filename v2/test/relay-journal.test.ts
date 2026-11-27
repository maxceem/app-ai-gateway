/**
 * The relay's journal and adapters (step 9a part 2; plan 5.2): pure functions,
 * so these run without a session. The session's use of them is in
 * `relay-start.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { addUsage, confirm, countMeasure, digestOf, finalSliceOf, freeze, JOURNAL_MAX_BYTES, JOURNAL_VERSION, markActive, markAttached, markAudio, markDetached, newJournal, readJournal, SEEN_IDS } from "../relay/src/journal.js";
import { adapterFor, typeOf } from "../relay/src/adapters.js";

describe("journal", () => {
  it("adds per-turn usage, and skips an event it already counted", () => {
    const journal = newJournal(0);
    expect(addUsage(journal, { id: "e1", measures: { input_tokens: 10, output_tokens: 2 } }, "per_turn", 0)).toBe(true);
    expect(addUsage(journal, { id: "e1", measures: { input_tokens: 10, output_tokens: 2 } }, "per_turn", 0)).toBe(false);
    addUsage(journal, { id: "e2", measures: { input_tokens: 5 } }, "per_turn", 0);
    expect(journal.measures).toEqual({ input_tokens: 15, output_tokens: 2 });
  });

  it("adds only the growth of a running total, across slices, and never subtracts", () => {
    const journal = newJournal(0);
    addUsage(journal, { id: "t1", measures: { input_tokens: 100 } }, "running_total", 0);
    addUsage(journal, { id: "t2", measures: { input_tokens: 150 } }, "running_total", 0);
    expect(freeze(journal, 1_000)?.measures).toEqual({ input_tokens: 150 });
    addUsage(journal, { id: "t3", measures: { input_tokens: 120 } }, "running_total", 0);
    addUsage(journal, { id: "t4", measures: { input_tokens: 200 } }, "running_total", 0);
    expect(freeze(journal, 2_000)?.measures).toEqual({ input_tokens: 50 });
  });

  it("keeps a bounded list of seen ids", () => {
    const journal = newJournal(0);
    for (let i = 0; i < SEEN_IDS + 10; i++) addUsage(journal, { id: `e${i}`, measures: { output_tokens: 1 } }, "per_turn", 0);
    expect(journal.seen).toHaveLength(SEEN_IDS);
    expect(journal.measures).toEqual({ output_tokens: SEEN_IDS + 10 });
  });

  it("numbers frozen slices in order, keeps them until confirmed, and freezes nothing when nothing happened", () => {
    const journal = newJournal(1_000);
    expect(freeze(journal, 1_000)).toBeNull();
    const one = freeze(journal, 61_000);
    expect(one).toEqual({ seq: 1, measures: {}, sessionMs: 60_000, gapMs: 0, gaps: 0, from: 1_000, to: 61_000 });
    addUsage(journal, { id: "e1", measures: { input_tokens: 3 } }, "per_turn", 0);
    expect(freeze(journal, 61_000)).toMatchObject({ seq: 2, sessionMs: 0, measures: { input_tokens: 3 } });
    expect(journal.unsent.map((s) => s.seq)).toEqual([1, 2]);
    confirm(journal, 1);
    expect(journal.unsent.map((s) => s.seq)).toEqual([2]);
    expect(finalSliceOf(journal)).toBe(2);
    expect(finalSliceOf(null)).toBe(0);
  });

  it("never freezes a slice that ends before it began: a clock past the deadline, or one that stepped back (Gemini Neon, #265 round 1)", () => {
    const journal = newJournal(100_000);
    addUsage(journal, { id: "e1", measures: { input_tokens: 5 } }, "per_turn", 100_000);
    const slice = freeze(journal, 90_000, { gapFrom: 95_000 });
    expect(slice).toMatchObject({ from: 100_000, to: 100_000, sessionMs: 0, gapMs: 0, measures: { input_tokens: 5 } });
  });

  it("counts an observed session's time without its side channel as a gap, and a side channel still down goes on into the next slice", () => {
    const journal = newJournal(0);
    markDetached(journal, 10_000);
    // A second close while it is down keeps the first time.
    markDetached(journal, 15_000);
    markAttached(journal, 25_000);
    markDetached(journal, 50_000);
    expect(freeze(journal, 60_000)).toMatchObject({ sessionMs: 35_000, gapMs: 25_000, gaps: 1 });
    // Still down: the next slice starts detached.
    markAttached(journal, 70_000);
    expect(freeze(journal, 120_000)).toMatchObject({ sessionMs: 50_000, gapMs: 10_000, gaps: 1 });
    expect(freeze(journal, 180_000)).toMatchObject({ sessionMs: 60_000, gapMs: 0, gaps: 0 });
    // A journal written before these fields reads the same.
    expect(readJournal({ ...newJournal(0) })).not.toBeNull();
  });

  it("counts the time after a crash as a gap, not connection time", () => {
    const journal = newJournal(0);
    expect(freeze(journal, 90_000, { gapFrom: 30_000 })).toMatchObject({ sessionMs: 30_000, gapMs: 60_000, gaps: 1 });
    // A crash before the open usage started: all of it is a gap.
    expect(freeze(journal, 120_000, { gapFrom: 10_000 })).toMatchObject({ sessionMs: 0, gapMs: 30_000, gaps: 1 });
  });

  it("counts every event of a long session with long escaped ids: ids are kept as fixed-size digests (Sol round 2)", () => {
    const journal = newJournal(0);
    // 128-character ids that grow six times when escaped in JSON.
    const id = (i: number) => String(i).padStart(5, "0") + "\u0001".repeat(123);
    let at = 0;
    for (let i = 0; i < 2_000; i += 1) {
      expect(addUsage(journal, { id: id(i), measures: { input_tokens: 1 } }, "per_turn", i)).toBe(true);
      // A slice every 100 events, confirmed at once.
      if (i % 100 === 99) {
        at = i + 1;
        const slice = freeze(journal, at);
        expect(slice).toMatchObject({ measures: { input_tokens: 100 }, gaps: 0, gapMs: 0 });
        confirm(journal, slice!.seq);
      }
    }
    expect(journal.seen).toHaveLength(SEEN_IDS);
    expect(journal.seen.every((digest) => /^[0-9a-f]{14}$/.test(digest))).toBe(true);
    expect(journal.seen.at(-1)).toBe(digestOf(id(1_999)));
    expect(new TextEncoder().encode(JSON.stringify(journal)).length).toBeLessThan(JOURNAL_MAX_BYTES / 8);
    // A recent repeat is still skipped.
    expect(addUsage(journal, { id: id(1_999), measures: { input_tokens: 1 } }, "per_turn", at)).toBe(false);
  });

  it("merges a dropped-usage gap and a crash gap, so time they share counts once (Sol round 2)", () => {
    const journal = newJournal(0);
    addUsage(journal, { id: "e1", measures: { input_tokens: 1 } }, "per_turn", 10_000);
    // Usage was dropped at the hard size from 20 s; the instance then crashed after its write at 30 s.
    journal.droppedFrom = 20_000;
    const slice = freeze(journal, 90_000, { gapFrom: 30_000 });
    // One gap from 20 s to 90 s, not 70 s + 60 s; never longer than the slice.
    expect(slice).toMatchObject({ sessionMs: 30_000, gapMs: 70_000, gaps: 2, from: 0, to: 90_000 });
    expect(slice!.gapMs).toBeLessThanOrEqual(slice!.to - slice!.from);
  });

  it("keeps a clock that starts at the first activity: free before it, billed from it to the slice's end (xAI, step 9b)", () => {
    const journal = newJournal(1_000, { idle: true });
    // Nothing happened yet: no slice, no connection time, and no gap either.
    expect(freeze(journal, 31_000)).toBeNull();
    expect(journal.idle).toBe(true);
    // The first activity, 40 s in: the free time stays in the same open usage.
    expect(markActive(journal, 41_000)).toBe(true);
    expect(markActive(journal, 45_000)).toBe(false);
    expect(journal.activeAt).toBe(41_000);
    expect(freeze(journal, 91_000)).toMatchObject({ seq: 1, sessionMs: 50_000, gapMs: 0, gaps: 0, from: 1_000, to: 91_000 });
    // From then on, every slice is billed whole, to the close.
    expect(freeze(journal, 101_000)).toMatchObject({ seq: 2, sessionMs: 10_000, gapMs: 0 });
    // A crash keeps its gap rule: the time since the last write is unknown, not free.
    expect(freeze(journal, 121_000, { gapFrom: 111_000 })).toMatchObject({ seq: 3, sessionMs: 10_000, gapMs: 10_000 });
    // The clock's start is kept in storage, so a restart reads it back.
    const idle = newJournal(0, { idle: true });
    markActive(idle, 5_000);
    expect(readJournal(structuredClone(idle))).toMatchObject({ idleMs: 5_000, activeAt: 5_000 });
    expect(newJournal(0)).not.toHaveProperty("idle");
  });

  it("bills each slice the growth of the larger of the clock and the provider's audio total (xAI, plan 5.2 rule 3)", () => {
    const journal = newJournal(0, { idle: true });
    markActive(journal, 0);
    expect(markAudio(journal, 50_000)).toBe(true);
    expect(markAudio(journal, 40_000)).toBe(false);
    expect(freeze(journal, 10_000)).toMatchObject({ sessionMs: 10_000, billedMs: 50_000 });
    expect(freeze(journal, 70_000)).toMatchObject({ sessionMs: 60_000, billedMs: 20_000 });
    expect(journal).toMatchObject({ clockMs: 70_000, audioMs: 50_000, billedMs: 70_000 });
    // A journal for any other provider carries no billed time.
    expect(freeze(newJournal(0), 1_000)).not.toHaveProperty("billedMs");
    // Audio that grows with no time passing still makes a slice.
    markAudio(journal, 90_000);
    expect(freeze(journal, 70_000)).toMatchObject({ sessionMs: 0, billedMs: 20_000 });
  });

  it("counts a measure the relay counts itself, and freezes it with the slice (xAI's text messages)", () => {
    const journal = newJournal(0);
    countMeasure(journal, "text_messages", 1);
    countMeasure(journal, "text_messages", 1);
    expect(freeze(journal, 1_000)?.measures).toEqual({ text_messages: 2 });
    expect(journal.measures).toEqual({});
  });

  it("reads only a journal in a format it knows", () => {
    const journal = newJournal(0);
    expect(readJournal(structuredClone(journal))).toEqual(journal);
    expect(readJournal({ ...journal, v: JOURNAL_VERSION + 1 })).toBeNull();
    expect(readJournal(undefined)).toBeNull();
  });
});

describe("adapters", () => {
  it("reads the mock's usage events and nothing else", () => {
    const mock = adapterFor("mock");
    expect(mock.shape).toBe("per_turn");
    expect(mock.read('{"type":"mock.usage","event_id":"e1","usage":{"input_tokens":7,"output_tokens":3}}')).toEqual({
      id: "e1",
      measures: { input_tokens: 7, output_tokens: 3 },
    });
    // Unknown measures and bad counts are dropped; an event with no id is not one.
    expect(mock.read('{"type":"mock.usage","event_id":"e2","usage":{"dollars":5,"input_tokens":-1,"output_tokens":1.5}}')).toEqual({ id: "e2", measures: {} });
    expect(mock.read('{"type":"mock.usage","usage":{"input_tokens":7}}')).toBeNull();
    expect(mock.read('{"type":"mock.usage", broken')).toBeNull();
    // Any other frame is never parsed.
    expect(mock.read('{"event_id":"e3","type":"mock.usage","usage":{"input_tokens":7}}')).toBeNull();
    expect(mock.read(new ArrayBuffer(8))).toBeNull();
    expect(adapterFor("mock_total").shape).toBe("running_total");
  });

  it("reads nothing for an adapter this relay does not know", () => {
    for (const name of ["openai_ws", undefined, "__proto__", "toString"]) {
      expect(adapterFor(name).read('{"type":"mock.usage","event_id":"e1","usage":{"input_tokens":7}}')).toBeNull();
      // And never waits for an answer when the session closes.
      expect(adapterFor(name).turn('{"type":"response.created"}')).toBeNull();
    }
  });

  it("tells when an answer opens and when it is done, from a cheap prefix check (step 9a part 3)", () => {
    const mock = adapterFor("mock");
    expect(mock.turn('{"type":"response.created","response":{}}')).toBe("open");
    expect(mock.turn('{"type":"response.done","response":{}}')).toBe("done");
    expect(mock.turn('{"type":"response.output_audio.delta","delta":"AAAA"}')).toBeNull();
    // Only a frame that starts with the type is looked at, as for usage.
    expect(mock.turn('{"response":{},"type":"response.done"}')).toBeNull();
    expect(mock.turn(new ArrayBuffer(8))).toBeNull();
  });

  it("reads a frame's top-level type: from its start when it comes first, else by parsing, never a nested one (Sol, #266 round 1)", () => {
    expect(typeOf('{"type":"ping","event_id":"e1"}')).toBe("ping");
    expect(typeOf('{"event_id":"0d6c3a41-2c55-4a7c-9a3c-6a4b1c0f8f31", "type" : "response.done"}')).toBe("response.done");
    // An item's own `type` comes first in the text, but it is not the frame's.
    expect(typeOf(JSON.stringify({ item: { type: "message", content: [{ type: "input_text", text: "Hi" }] }, type: "conversation.item.create" }))).toBe("conversation.item.create");
    // The type far from both ends of a long frame.
    expect(typeOf(JSON.stringify({ event_id: "e1", audio: "A".repeat(4_000), type: "input_audio_buffer.append", note: "B".repeat(4_000) }))).toBe("input_audio_buffer.append");
    expect(typeOf(`{"audio":"${"A".repeat(4_000)}"}`)).toBeNull();
    expect(typeOf("not json")).toBeNull();
  });

  it("xAI: its clock starts at the first audio or xAI's first answer, each text message counts, ping is only a keepalive, and response.done's total is a check (T5, T20)", () => {
    const xai = adapterFor("xai");
    expect(xai).toMatchObject({ clock: "first_activity", detached: "hold" });
    // The client's frames, read after they went to xAI.
    expect(xai.client?.(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }))).toBe("activity");
    expect(xai.client?.(`{"audio":"${"A".repeat(4_000)}","type":"input_audio_buffer.append"}`)).toBe("activity");
    expect(xai.client?.(new ArrayBuffer(960))).toBe("activity");
    // Asking for an answer is not activity: xAI's answer, when it comes, starts the clock (Sol, #266 round 3).
    expect(xai.client?.(JSON.stringify({ type: "response.create" }))).toBeNull();
    const text = JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] } });
    expect(xai.client?.(text)).toBe("text");
    // The same two frames with their fields in another order (Sol, #266 round 1).
    expect(xai.client?.(JSON.stringify({ item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }, type: "conversation.item.create" }))).toBe("text");
    expect(xai.client?.(JSON.stringify({ audio: "A".repeat(4_000), type: "input_audio_buffer.append", event_id: "B".repeat(400) }))).toBe("activity");
    // A tool result is not billed; an item with audio goes to the audio meter (xAI's speech-to-speech guide).
    expect(xai.client?.(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "{}" } }))).toBeNull();
    expect(xai.client?.(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_audio", audio: "AAAA" }] } }))).toBe("activity");
    expect(xai.client?.(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "audio", audio: "AAAA" }] } }))).toBe("activity");
    expect(xai.client?.(JSON.stringify({ type: "session.update", session: { voice: "eve" } }))).toBeNull();
    // xAI's frames: an answer opens and ends, and a ping says only "still here".
    expect(xai.turn('{"type":"response.created","response":{"id":"r1"}}')).toBe("open");
    expect(xai.turn('{"event_id":"e9","type":"response.done","response":{"id":"r1"}}')).toBe("done");
    expect(xai.keepalive?.('{"type":"ping","event_id":"p1"}')).toBe(true);
    expect(xai.keepalive?.('{"type":"response.output_audio.delta","delta":"AAAA"}')).toBe(false);
    // `billable_audio_seconds` is read as a check, never as a measure that bills.
    const done = JSON.stringify({ type: "response.done", event_id: "e9", response: { id: "r1", usage: { input_tokens: 0 } }, usage: { output_audio_seconds: 2.9, billable_audio_seconds: 16 } });
    expect(xai.read(done)).toEqual({ id: "e9", measures: {}, audioSeconds: 16 });
    expect(xai.read(JSON.stringify({ type: "response.done", event_id: "e8", usage: { output_audio_seconds: 0.4 } }))).toBeNull();
    expect(xai.read('{"type":"ping"}')).toBeNull();
  });
});
