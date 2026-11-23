import { describe, expect, it } from "vitest";
import { diffOperations } from "./json-patch";

describe("diffOperations", () => {
  it("names only the fields that changed, escaping keys", () => {
    expect(diffOperations("/config/x", { a: 1, b: { c: 2, d: 3 }, "e/f": 1 }, { a: 1, b: { c: 2, d: 4 }, "e/f": 2, g: true })).toEqual([
      { op: "replace", path: "/config/x/b/d", value: 4 },
      { op: "replace", path: "/config/x/e~1f", value: 2 },
      { op: "add", path: "/config/x/g", value: true },
    ]);
  });

  it("replaces the object holding a key a patch path cannot name", () => {
    const before = { rewrites: { constructor: "a", other: "b" }, kept: 1 };
    const after = { rewrites: { constructor: "c", other: "b" }, kept: 1 };
    expect(diffOperations("/config/routing", before, after)).toEqual([
      { op: "replace", path: "/config/routing/rewrites", value: { constructor: "c", other: "b" } },
    ]);
  });

  it("replaces the whole part when a change touches more fields than one request takes", () => {
    const before = { a: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index])), b: { x: 1 } };
    const after = { a: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index + 1])), b: { x: 2 } };
    expect(diffOperations("/config/presets", before, after)).toEqual([{ op: "replace", path: "/config/presets", value: after }]);
  });

  it("adds a part that was not there, and removes one that goes", () => {
    expect(diffOperations("/config/presets", undefined, { quick: { model: "m" } })).toEqual([{ op: "add", path: "/config/presets", value: { quick: { model: "m" } } }]);
    expect(diffOperations("/config/presets", { quick: { model: "m" } }, undefined)).toEqual([{ op: "remove", path: "/config/presets" }]);
  });
});
