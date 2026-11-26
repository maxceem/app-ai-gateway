/**
 * The relay's journal and adapters (step 9a part 2; plan 5.2): pure functions,
 * so these run without a session. The session's use of them is in
 * `relay-start.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { addUsage, confirm, finalSliceOf, freeze, JOURNAL_VERSION, newJournal, readJournal, SEEN_IDS } from "../relay/src/journal.js";
import { adapterFor } from "../relay/src/adapters.js";

describe("journal", () => {
  it("adds per-turn usage, and skips an event it already counted", () => {
    const journal = newJournal(0);
    expect(addUsage(journal, { id: "e1", measures: { input_tokens: 10, output_tokens: 2 } }, "per_turn")).toBe(true);
    expect(addUsage(journal, { id: "e1", measures: { input_tokens: 10, output_tokens: 2 } }, "per_turn")).toBe(false);
    addUsage(journal, { id: "e2", measures: { input_tokens: 5 } }, "per_turn");
    expect(journal.measures).toEqual({ input_tokens: 15, output_tokens: 2 });
  });

  it("adds only the growth of a running total, across slices, and never subtracts", () => {
    const journal = newJournal(0);
    addUsage(journal, { id: "t1", measures: { input_tokens: 100 } }, "running_total");
    addUsage(journal, { id: "t2", measures: { input_tokens: 150 } }, "running_total");
    expect(freeze(journal, 1_000)?.measures).toEqual({ input_tokens: 150 });
    addUsage(journal, { id: "t3", measures: { input_tokens: 120 } }, "running_total");
    addUsage(journal, { id: "t4", measures: { input_tokens: 200 } }, "running_total");
    expect(freeze(journal, 2_000)?.measures).toEqual({ input_tokens: 50 });
  });

  it("keeps a bounded list of seen ids", () => {
    const journal = newJournal(0);
    for (let i = 0; i < SEEN_IDS + 10; i++) addUsage(journal, { id: `e${i}`, measures: { output_tokens: 1 } }, "per_turn");
    expect(journal.seen).toHaveLength(SEEN_IDS);
    expect(journal.measures).toEqual({ output_tokens: SEEN_IDS + 10 });
  });

  it("numbers frozen slices in order, keeps them until confirmed, and freezes nothing when nothing happened", () => {
    const journal = newJournal(1_000);
    expect(freeze(journal, 1_000)).toBeNull();
    const one = freeze(journal, 61_000);
    expect(one).toEqual({ seq: 1, measures: {}, sessionMs: 60_000, gapMs: 0, gaps: 0, from: 1_000, to: 61_000 });
    addUsage(journal, { id: "e1", measures: { input_tokens: 3 } }, "per_turn");
    expect(freeze(journal, 61_000)).toMatchObject({ seq: 2, sessionMs: 0, measures: { input_tokens: 3 } });
    expect(journal.unsent.map((s) => s.seq)).toEqual([1, 2]);
    confirm(journal, 1);
    expect(journal.unsent.map((s) => s.seq)).toEqual([2]);
    expect(finalSliceOf(journal)).toBe(2);
    expect(finalSliceOf(null)).toBe(0);
  });

  it("counts the time after a crash as a gap, not connection time", () => {
    const journal = newJournal(0);
    expect(freeze(journal, 90_000, { gapFrom: 30_000 })).toMatchObject({ sessionMs: 30_000, gapMs: 60_000, gaps: 1 });
    // A crash before the open usage started: all of it is a gap.
    expect(freeze(journal, 120_000, { gapFrom: 10_000 })).toMatchObject({ sessionMs: 0, gapMs: 30_000, gaps: 1 });
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
    }
  });
});
