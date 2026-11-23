import { describe, expect, it } from "vitest";
import { emptyRow, formCanShow, hiddenFields, jsonPriceProblem, pricingOf, rowProblems, rowsOf, UNIT_FIELDS } from "./pricing-form";
import { readPrice } from "@contracts/price-amount";
import { UNIT_RATE_FIELDS } from "../../../src/pricing/units.ts";

describe("the prices form", () => {
  it("changes only the fields a row shows, and keeps everything else a price carries", () => {
    const stored = {
      "gpt-x": { input: 1, output: 4, cache_write: 2, long_context_threshold: 200000, long_input: 2, long_output: 8, modes: { flex: { factor: 0.5 } } },
    };
    const [row] = rowsOf(stored);
    expect(hiddenFields(row!)).toEqual(["cache_write", "long_context_threshold", "long_input", "long_output", "modes"]);
    const edited = { ...row!, tokens: { ...row!.tokens, output: "5" } };
    expect(pricingOf([edited])).toEqual({ "gpt-x": { ...stored["gpt-x"], output: 5 } });
  });

  it("reads a single unit rate into the row, and moves it when the unit changes", () => {
    const [row] = rowsOf({ "fal-ai/x": { per_unit: 0.01 } });
    expect(row).toMatchObject({ unitField: "per_unit", unitAmount: "0.01" });
    expect(pricingOf([{ ...row!, unitField: "per_request", unitAmount: "0.02" }])).toEqual({ "fal-ai/x": { per_request: 0.02 } });
  });

  it("keeps several unit rates as stored, shown as kept", () => {
    const [row] = rowsOf({ "m": { per_image: 0.04, per_megapixel: 0.01 } });
    expect(row!.unitField).toBe("");
    expect(hiddenFields(row!)).toEqual(["per_image", "per_megapixel"]);
    expect(pricingOf([row!])).toEqual({ m: { per_image: 0.04, per_megapixel: 0.01 } });
  });

  it("renames a model by its key and drops a removed one", () => {
    const rows = rowsOf({ a: { per_request: 1 }, b: { per_request: 2 } });
    expect(pricingOf([{ ...rows[0]!, model: "a2" }])).toEqual({ a2: { per_request: 1 } });
    expect(pricingOf([])).toBeNull();
  });

  it("says what is wrong with a row", () => {
    const row = { ...emptyRow(), model: "m", tokens: { input: "1", output: "", cached_input: "x" } };
    expect(rowProblems(row, [row])).toMatchObject({ cached_input: expect.any(String), output: "Input and output are priced together." });
    const blank = { ...emptyRow(), model: "n" };
    expect(rowProblems(blank, [blank]).row).toBe("Give this model at least one rate.");
    const twice = [{ ...emptyRow(), model: "same", unitField: "per_request", unitAmount: "1" }, { ...emptyRow(), model: "same ", unitField: "per_request", unitAmount: "1" }];
    expect(rowProblems(twice[0]!, twice).model).toBe("This model is listed twice.");
  });

  it("reads back every stored rate as itself, exponents included", () => {
    for (const value of [1e-9, 2.5e-7, 0.000001, 1234.5678, 3e5]) {
      const [row] = rowsOf({ m: { per_request: value } });
      expect(rowProblems(row!, [row!])).toEqual({});
      expect(pricingOf([row!])).toEqual({ m: { per_request: value } });
    }
  });

  it("knows which stored prices the form cannot show", () => {
    expect(formCanShow(null)).toBe(true);
    expect(formCanShow({ m: { input: 1, output: 2, modes: { flex: { factor: 0.5 } } } })).toBe(true);
    expect(formCanShow({ m: null })).toBe(false);
    expect(formCanShow({ m: [1] })).toBe(false);
    expect(formCanShow({ m: { input: "1" } })).toBe(false);
    expect(formCanShow([])).toBe(false);
  });

  it("offers every unit the gateway prices, and no other", () => {
    expect(UNIT_FIELDS.map((entry) => entry.field).sort()).toEqual([...UNIT_RATE_FIELDS].sort());
  });

  it("judges a typed amount by the gateway's money rule", () => {
    const priced = (text: string) => ({ ...emptyRow(), model: "m", unitField: "per_request", unitAmount: text });
    const fine = priced("1e-10");
    expect(rowProblems(fine, [fine]).unit).toMatch(/would be stored as 0\.000000001/u);
    const ok = priced("2.50");
    expect(rowProblems(ok, [ok]).unit).toBeUndefined();
  });

  it("never judges a stored amount again, so an old price does not lock the form", () => {
    const [row] = rowsOf({ m: { per_request: 1e-10, input: 0.30000000000000004, output: 1 } });
    expect(rowProblems(row!, [row!])).toEqual({});
    expect(pricingOf([row!])).toEqual({ m: { per_request: 1e-10, input: 0.30000000000000004, output: 1 } });
    // Typed again as other text, the same rule as any new amount applies.
    const typed = { ...row!, unitAmount: "1e-11" };
    expect(rowProblems(typed, [typed]).unit).toMatch(/would be stored as/u);
  });

  it("refuses __proto__ as a model name, keeps constructor and prototype, and builds the prices without a prototype path", () => {
    for (const model of ["__proto__", " __proto__ "]) {
      const row = { ...emptyRow(), model, unitField: "per_request", unitAmount: "1" };
      expect(rowProblems(row, [row]).model).toBe("This is not a model name.");
    }
    for (const model of ["constructor", "prototype"]) {
      const row = { ...emptyRow(), model, unitField: "per_request", unitAmount: "1" };
      expect(rowProblems(row, [row]).model).toBeUndefined();
      expect(pricingOf([row])).toEqual({ [model]: { per_request: 1 } });
    }
    const built = pricingOf([{ ...emptyRow(), model: "m", unitField: "per_request", unitAmount: "1" }]);
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
    expect(built).toEqual({ m: { per_request: 1 } });
  });

  it("judges JSON amounts as written, not as a float reads them", () => {
    expect(jsonPriceProblem('{"m": {"per_request": 1e-400}}')).toMatch(/^per_request 1e-400: .*stored as 0\./u);
    expect(jsonPriceProblem('{"m": {"input": 1.0000000000000001, "output": 2}}')).toMatch(/^input 1\.0000000000000001: /u);
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2.5, "long_context_threshold": 200000, "modes": {"flex": {"factor": 0.33333333333}}}}')).toBeNull();
    // A number inside a string is not an amount.
    expect(jsonPriceProblem('{"1e-400 model": {"per_request": 0.02}}')).toBeNull();
  });

  it("never judges a stored JSON amount again, only new or changed ones", () => {
    const stored = '{"m": {"per_request": 1e-10}}';
    expect(jsonPriceProblem(stored, stored)).toBeNull();
    expect(jsonPriceProblem('{"m": {"per_request": 1e-10}, "n": {"per_request": 1}}', stored)).toBeNull();
    expect(jsonPriceProblem('{"m": {"per_request": 1e-11}}', stored)).toMatch(/^per_request 1e-11: /u);
    // The same text under another model is new.
    expect(jsonPriceProblem('{"n": {"per_request": 1e-10}}', stored)).toMatch(/^per_request 1e-10: /u);
  });

  it("reads a price exactly, and never throws on an absurd one", () => {
    expect(readPrice("2.50")).toEqual({ value: 2.5 });
    expect(readPrice("1e-9")).toEqual({ value: 1e-9 });
    expect(readPrice("0e9007199254740992")).toEqual({ value: 0 });
    expect(readPrice("0.000e-99999")).toEqual({ value: 0 });
    expect(readPrice("x", "0.04")).toEqual({ problem: "Enter an amount, such as 0.04." });
    expect(readPrice("-1")).toEqual({ problem: "A price cannot be negative." });
    expect(readPrice("1e-10")).toEqual({ problem: "Prices are kept to $0.000000001; this would be stored as 0.000000001." });
    expect(readPrice("1e-400")).toEqual({ problem: "Prices are kept to $0.000000001; this would be stored as 0." });
    expect(readPrice("1.0000000000000001")).toEqual({ problem: "Prices are kept to $0.000000001; this would be stored as 1." });
    expect(readPrice("1e9007199254740992")).toMatchObject({ problem: expect.stringMatching(/too large an exponent/u) });
    expect(readPrice("1e-9007199254740992")).toMatchObject({ problem: expect.stringMatching(/too large an exponent/u) });
    expect(readPrice(`0.${"1".repeat(60)}`)).toMatchObject({ problem: expect.stringMatching(/too many digits/u) });
    expect(readPrice("1e300")).toEqual({ problem: "This price is too large to store." });
  });

  it("refuses a key written twice in one object, which parsing would quietly reduce to the last", () => {
    expect(jsonPriceProblem('{"m": {"per_request": 1}, "m": {"per_request": 2}}')).toBe('"m" is written twice in one object; only the last would be kept.');
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "input": 3}}')).toBe('"input" is written twice in one object; only the last would be kept.');
    // The same name written with an escape is the same key.
    expect(jsonPriceProblem('{"m": {"per_request": 1}, "\\u006d": {"per_request": 2}}')).toMatch(/"m" is written twice/u);
    // The same field in two different objects is fine.
    expect(jsonPriceProblem('{"a": {"per_request": 1}, "b": {"per_request": 2}}')).toBeNull();
  });

  it("refuses a factor or threshold whose value would change once read, compared as written", () => {
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "modes": {"flex": {"factor": 1e-400}}}}')).toBe("factor 1e-400: this factor would be read as 0. Write it with fewer digits.");
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "modes": {"flex": {"factor": 0.99999999999999999}}}}')).toBe(
      "factor 0.99999999999999999: this factor would be read as 1. Write it with fewer digits.",
    );
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "long_input": 2, "long_output": 4, "long_context_threshold": 200000.00000000001}}')).toMatch(
      /^long_context_threshold 200000\.00000000001: this would be read as 200000\./u,
    );
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "long_input": 2, "long_output": 4, "long_context_threshold": 200000.5}}')).toBe(
      "long_context_threshold 200000.5: write a whole number of tokens.",
    );
    // Written another way, the same value is fine.
    for (const factor of ["0", "0.5", "5e-1", "0.50", "1", "1.0", "2E3", "0.333333333333333", "0.33333333333333"]) {
      expect(jsonPriceProblem(`{"m": {"input": 1, "output": 2, "modes": {"flex": {"factor": ${factor}}}}}`)).toBeNull();
    }
    expect(jsonPriceProblem('{"m": {"input": 1, "output": 2, "long_input": 2, "long_output": 4, "long_context_threshold": 2e5}}')).toBeNull();
  });
});
