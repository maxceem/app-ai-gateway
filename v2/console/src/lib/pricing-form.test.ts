import { describe, expect, it } from "vitest";
import { emptyRow, formCanShow, hiddenFields, pricingOf, rowProblems, rowsOf } from "./pricing-form";

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

  it("refuses an amount the gateway would store as another figure, or as 0", () => {
    const priced = (text: string) => ({ ...emptyRow(), model: "m", unitField: "per_request", unitAmount: text });
    const tiny = priced("1e-400");
    expect(rowProblems(tiny, [tiny]).unit).toBe("This amount is too small: it would be stored as 0.");
    const fine = priced("1e-10");
    expect(rowProblems(fine, [fine]).unit).toMatch(/kept to \$0\.000000001; this would be stored as 0\.000000001/u);
    const zero = priced("0");
    expect(rowProblems(zero, [zero]).unit).toBeUndefined();
  });

  it("refuses model names that cannot be a key of the prices, and builds the prices without a prototype path", () => {
    for (const model of ["__proto__", "constructor", "prototype"]) {
      const row = { ...emptyRow(), model, unitField: "per_request", unitAmount: "1" };
      expect(rowProblems(row, [row]).model).toBe("This is not a model name.");
    }
    const built = pricingOf([{ ...emptyRow(), model: "m", unitField: "per_request", unitAmount: "1" }]);
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
    expect(built).toEqual({ m: { per_request: 1 } });
  });
});
