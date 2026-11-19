import { describe, expect, it } from "vitest";
import { dollarsToNano, nanoToDollarText, nanoToDollars } from "./money";

describe("money", () => {
  it("turns typed dollars into whole nano-dollars, exactly", () => {
    expect(dollarsToNano("25")).toBe(25_000_000_000);
    expect(dollarsToNano("0.5")).toBe(500_000_000);
    expect(dollarsToNano(" 0.000000001 ")).toBe(1);
    expect(dollarsToNano("0")).toBe(0);
  });

  it("refuses what is not a plain amount", () => {
    for (const bad of ["", "-1", "1e3", "abc", "1.0000000001", "$5"]) expect(dollarsToNano(bad)).toBeNull();
  });

  it("shows nano-dollars as dollars, round-tripping the text", () => {
    expect(nanoToDollarText(25_000_000_000)).toBe("25");
    expect(nanoToDollarText(500_000_000)).toBe("0.5");
    expect(dollarsToNano(nanoToDollarText(123_456_789))).toBe(123_456_789);
    expect(nanoToDollars(1_500_000_000)).toBe(1.5);
  });
});
