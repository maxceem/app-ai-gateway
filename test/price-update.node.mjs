import assert from "node:assert/strict";
import test from "node:test";
import { priceUpdateProblems } from "../scripts/check-price-update.mjs";

const list = (entries) => ({ openai: entries });
const model = { kind: "text", input: 2, cached_input: 0.5, output: 8, modes: { fast: { factor: 2 }, flex: { factor: 0.5 } } };

test("a price update that only adds and moves prices within bounds passes", () => {
  const after = list({
    a: { ...model, input: 3, modes: { ...model.modes, ultrafast: { factor: 6 } }, retirement_date: "2027-01-01" },
    b: { kind: "text", input: 1, output: 4 },
  });
  assert.deepEqual(priceUpdateProblems(list({ a: model }), after), []);
});

test("a model or mode that disappears fails, and one kept marked unlisted passes", () => {
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({})), ["openai/a: the model is gone"]);
  const { fast: _fast, ...rest } = model.modes;
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: { ...model, modes: rest } })), [
    "openai/a: service mode fast is gone",
  ]);
  const kept = { ...model, modes: { ...model.modes, fast: { factor: 2, input: 4, output: 16, unlisted_since: "2026-11-30" } } };
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: kept })), []);
});

test("a changed kind, billing unit or dropped rate fails", () => {
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: { ...model, kind: "image" } })), [
    "openai/a: kind text → image",
  ]);
  assert.deepEqual(
    priceUpdateProblems(list({ a: { kind: "transcription", per_minute: 0.006 } }), list({ a: { kind: "transcription", input: 1, output: 4 } })),
    ["openai/a: billed per_minute → token"],
  );
  const { cached_input: _cached, ...uncached } = model;
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: uncached })), ["openai/a: cached_input is gone"]);
});

test("a rate that moves more than 3x, or to or from free, fails, in any mode", () => {
  // A mode priced by a factor moves with the standard rate, and says so too.
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: { ...model, output: 30 } })), [
    "openai/a: output $8 → $30, more than 3x",
    "openai/a: fast output $16 → $60, more than 3x",
    "openai/a: flex output $4 → $15, more than 3x",
  ]);
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: { ...model, input: 0 } })), [
    "openai/a: input $2 → $0",
    "openai/a: fast input $4 → $0",
    "openai/a: flex input $1 → $0",
  ]);
  const dearer = { ...model, modes: { ...model.modes, fast: { factor: 7 } } };
  assert.deepEqual(priceUpdateProblems(list({ a: model }), list({ a: dearer })), [
    "openai/a: fast input $4 → $14, more than 3x",
    "openai/a: fast cached_input $1 → $3.5, more than 3x",
    "openai/a: fast output $16 → $56, more than 3x",
  ]);
});

test("a rate only a mode sets, dropped, fails: the mode would fall back to another rate", () => {
  const before = { kind: "text", input: 20, output: 40, modes: { flex: { factor: 0.5, cached_input: 0.1 } } };
  const after = { ...before, modes: { flex: { factor: 0.5 } } };
  assert.deepEqual(priceUpdateProblems(list({ a: before }), list({ a: after })), ["openai/a: flex cached_input is gone"]);
});

test("a tier in a region no entry names is checked as it is billed, tier times region", () => {
  const before = { kind: "text", input: 1, output: 2, modes: { fast: { factor: 2 }, us: { factor: 1.1 } } };
  // Each factor moves exactly 3x, which passes on its own; together they move 9x.
  const after = { ...before, modes: { fast: { factor: 6 }, us: { factor: 3.3 } } };
  assert.deepEqual(priceUpdateProblems(list({ a: before }), list({ a: after })), [
    "openai/a: fast+us input $2.2 → $19.8, more than 3x",
    "openai/a: fast+us output $4.4 → $39.6, more than 3x",
  ]);
  // A pair the update starts naming is checked against what it billed before.
  const named = { ...before, modes: { ...before.modes, "fast+us": { factor: 2.2 } } };
  assert.deepEqual(priceUpdateProblems(list({ a: before }), list({ a: named })), []);
});
