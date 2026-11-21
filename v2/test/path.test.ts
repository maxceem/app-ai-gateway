import { describe, expect, it } from "vitest";
import { encodeSegment, fillTemplate, joinSegments, matchTemplate, normalizePath, parseTemplate } from "../src/providers/path.ts";

describe("normalizePath", () => {
  it("decodes segments and drops repeated and trailing slashes", () => {
    expect(normalizePath("/v1//audio/%E2%9C%93/")).toEqual({ ok: true, segments: ["v1", "audio", "✓"] });
  });

  it.each([
    ["v1/../keys", "dot_segment"],
    ["v1/./keys", "dot_segment"],
    ["v1/%2e%2e/keys", "dot_segment"],
    ["v1/%2E/keys", "dot_segment"],
    ["v1/a%2Fb", "encoded_separator"],
    ["v1/a%2fb", "encoded_separator"],
    ["v1/a%5Cb", "encoded_separator"],
    ["v1/a\\b", "encoded_separator"],
    ["v1/a%00b", "control_character"],
    ["v1/a%0Ab", "control_character"],
    ["v1/%E2%9C", "bad_encoding"],
    ["v1/%zz", "bad_encoding"],
  ])("refuses %s", (raw, reason) => {
    expect(normalizePath(raw)).toEqual({ ok: false, reason });
  });
});

describe("double encoding", () => {
  it("decodes once, so an encoded `%2e%2e` reaches the provider as text, not as dots", () => {
    const normalized = normalizePath("v1/files/%252e%252e");
    expect(normalized).toEqual({ ok: true, segments: ["v1", "files", "%2e%2e"] });
    expect(joinSegments(["v1", "files", "%2e%2e"])).toBe("/v1/files/%252e%252e");
  });
});

describe("encodeSegment", () => {
  it("keeps characters a path segment may hold, and encodes the rest", () => {
    expect(encodeSegment("gemini-2.5-flash:generateContent")).toBe("gemini-2.5-flash:generateContent");
    expect(encodeSegment("a b?c#d")).toBe("a%20b%3Fc%23d");
    expect(encodeSegment("✓")).toBe("%E2%9C%93");
  });
});

describe("parseTemplate", () => {
  it.each([
    ["", {}],
    ["/", {}],
    ["v1//x", {}],
    ["v1/../x", {}],
    ["v1/{a}{b}", {}],
    ["v1/{a}/{a}", {}],
    ["v1/{a-b}", {}],
    ["v1/{rest...}", {}],
    ["v1/x{rest...}", { multi: true }],
    ["{a...}/{b...}", { multi: true }],
    ["v1/*", {}],
  ])("refuses %j with %j", (source, options) => {
    expect(() => parseTemplate(source, options)).toThrow();
  });
});

describe("matchTemplate", () => {
  it("matches a part to exactly one segment", () => {
    const template = parseTemplate("v1/things/{id}");
    expect(matchTemplate(template, ["v1", "things", "42"])).toEqual({ id: "42" });
    expect(matchTemplate(template, ["v1", "things", "42", "delete"])).toBeNull();
    expect(matchTemplate(template, ["v1", "things"])).toBeNull();
  });

  it("matches a part with a literal prefix and suffix in its segment", () => {
    const template = parseTemplate("v1beta/models/{model}:generateContent");
    expect(matchTemplate(template, ["v1beta", "models", "gemini-2.5-flash:generateContent"])).toEqual({
      model: "gemini-2.5-flash",
    });
    expect(matchTemplate(template, ["v1beta", "models", ":generateContent"])).toBeNull();
    expect(matchTemplate(template, ["v1beta", "models", "gemini:streamGenerateContent"])).toBeNull();
  });

  it("matches a multi-segment part only to a value on its closed list", () => {
    const template = parseTemplate("run/{model...}/extra", { multi: true });
    const closedLists = { model: new Set(["fal-ai/flux/dev"]) };
    expect(matchTemplate(template, ["run", "fal-ai", "flux", "dev", "extra"], { closedLists })).toEqual({
      model: "fal-ai/flux/dev",
    });
    expect(matchTemplate(template, ["run", "fal-ai", "flux", "pro", "extra"], { closedLists })).toBeNull();
    expect(matchTemplate(template, ["run", "extra"], { closedLists })).toBeNull();
    expect(matchTemplate(template, ["run", "fal-ai", "flux", "dev", "extra"])).toBeNull();
  });

  it("is case-sensitive", () => {
    const template = parseTemplate("v1/organization/{thing}");
    expect(matchTemplate(template, ["V1", "Organization", "admin_api_keys"])).toBeNull();
    expect(matchTemplate(template, ["v1", "organization", "admin_api_keys"])).toEqual({ thing: "admin_api_keys" });
  });
});

describe("fillTemplate", () => {
  it("encodes single parts and keeps a multi-segment value's slashes", () => {
    expect(fillTemplate(parseTemplate("v1/voices/{id}"), { id: "a b" })).toBe("/v1/voices/a%20b");
    expect(fillTemplate(parseTemplate("{model...}", { multi: true }), { model: "fal-ai/flux/dev" })).toBe(
      "/fal-ai/flux/dev",
    );
  });
});
