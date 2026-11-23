/**
 * JSON Patch on an app (`src/admin/app-patch.ts`): pointer escapes, array
 * positions, and a patch applying whole or not at all.
 *
 * Ported from v1's `admin-app-patch.test.ts`. Patching through the API, with
 * revisions and the saved result, is in `management.test.ts` and
 * `mcp.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { applyAppPatch } from "../src/admin/app-patch.ts";
import type { AppPatchOperation } from "../src/contracts/admin.ts";

function patched(document: Record<string, unknown>, operations: AppPatchOperation[]): Record<string, unknown> {
  return applyAppPatch(document, operations);
}

function refusal(document: Record<string, unknown>, operations: AppPatchOperation[]): string {
  try {
    applyAppPatch(document, operations);
  } catch (error) {
    expect(error).toMatchObject({ status: 400, code: "invalid_request" });
    return (error as Error).message;
  }
  throw new Error("expected the patch to be refused");
}

describe("pointers", () => {
  it("decodes ~1 as a slash and ~0 as a tilde, in that order", () => {
    const document = { headers: { "a/b": 1, "c~d": 2, "~1": 3 } };
    expect(patched(document, [{ op: "replace", path: "/headers/a~1b", value: 10 }]).headers).toMatchObject({ "a/b": 10 });
    expect(patched(document, [{ op: "replace", path: "/headers/c~0d", value: 20 }]).headers).toMatchObject({ "c~d": 20 });
    // `~01` is `~1` the text, not a slash: decoding `~1` first would get this wrong.
    expect(patched(document, [{ op: "replace", path: "/headers/~01", value: 30 }]).headers).toMatchObject({ "~1": 30 });
  });

  it("refuses a key that would reach an object's prototype", () => {
    for (const path of ["/__proto__/polluted", "/config/constructor", "/config/prototype"]) {
      expect(refusal({ config: {} }, [{ op: "add", path, value: true }])).toContain("names a reserved key");
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a path whose parent does not exist", () => {
    expect(refusal({ config: {} }, [{ op: "add", path: "/config/missing/leaf", value: 1 }])).toContain("its parent does not exist");
  });

  it("refuses a parent that is neither an object nor an array", () => {
    expect(refusal({ name: "x" }, [{ op: "add", path: "/name/length", value: 1 }])).toContain("its parent is not an object or an array");
  });
});

describe("objects", () => {
  it("lets add set a key that already exists, as RFC 6902 says", () => {
    expect(patched({ name: "old" }, [{ op: "add", path: "/name", value: "new" }])).toEqual({ name: "new" });
  });

  it("refuses replace and remove of a key that is not there", () => {
    expect(refusal({}, [{ op: "replace", path: "/name", value: "x" }])).toContain("nothing is there");
    expect(refusal({}, [{ op: "remove", path: "/name" }])).toContain("nothing is there");
  });

  it("never treats an inherited property as there", () => {
    expect(refusal({ config: {} }, [{ op: "remove", path: "/config/toString" }])).toContain("nothing is there");
  });
});

describe("arrays", () => {
  const document = () => ({ list: ["a", "b", "c"] });

  it("inserts at a position, appends with -, replaces and removes", () => {
    expect(patched(document(), [{ op: "add", path: "/list/1", value: "x" }]).list).toEqual(["a", "x", "b", "c"]);
    expect(patched(document(), [{ op: "add", path: "/list/3", value: "x" }]).list).toEqual(["a", "b", "c", "x"]);
    expect(patched(document(), [{ op: "add", path: "/list/-", value: "x" }]).list).toEqual(["a", "b", "c", "x"]);
    expect(patched(document(), [{ op: "replace", path: "/list/0", value: "x" }]).list).toEqual(["x", "b", "c"]);
    expect(patched(document(), [{ op: "remove", path: "/list/2" }]).list).toEqual(["a", "b"]);
  });

  it.each([
    ["a position past the end", { op: "add", path: "/list/4", value: "x" }, "the array has 3 entries"],
    ["a replace past the last entry", { op: "replace", path: "/list/3", value: "x" }, "the array has 3 entries"],
    ["a remove past the last entry", { op: "remove", path: "/list/3" }, "the array has 3 entries"],
    ["a position with a leading zero", { op: "replace", path: "/list/01", value: "x" }, "an array position is a number"],
    ["a negative position", { op: "remove", path: "/list/-1" }, "an array position is a number"],
    ["- outside add", { op: "replace", path: "/list/-", value: "x" }, "an array position is a number"],
    ["a name instead of a position", { op: "remove", path: "/list/first" }, "an array position is a number"],
  ] as const)("refuses %s", (_label, operation, message) => {
    expect(refusal(document(), [operation as AppPatchOperation])).toContain(message);
  });

  it("walks through an array position to an object inside it", () => {
    const result = patched({ fallbacks: [{ model: "a" }, { model: "b" }] }, [{ op: "replace", path: "/fallbacks/1/model", value: "c" }]);
    expect(result.fallbacks).toEqual([{ model: "a" }, { model: "c" }]);
  });
});

describe("a whole patch", () => {
  it("applies in order, each operation seeing the ones before it", () => {
    const result = patched({}, [
      { op: "add", path: "/config", value: {} },
      { op: "add", path: "/config/limits", value: { per_app: 1 } },
      { op: "replace", path: "/config/limits/per_app", value: 2 },
    ]);
    expect(result).toEqual({ config: { limits: { per_app: 2 } } });
  });

  it("applies whole or not at all, naming the operation that failed, and never changes its input", () => {
    const document = { name: "old", config: { a: 1 } };
    const message = refusal(document, [
      { op: "replace", path: "/name", value: "new" },
      { op: "remove", path: "/config/b" },
    ]);
    expect(message).toMatch(/^operations\[1\] \(remove \/config\/b\)/u);
    expect(document).toEqual({ name: "old", config: { a: 1 } });
  });

  it("copies the values it writes, so a later change to them is not seen", () => {
    const value = { nested: [1] };
    const result = patched({}, [{ op: "add", path: "/x", value }]);
    value.nested.push(2);
    expect(result).toEqual({ x: { nested: [1] } });
  });
});
