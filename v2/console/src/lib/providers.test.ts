import { describe, expect, it } from "vitest";
import { operationsOf, PROVIDER_TYPES, providerLabel } from "./providers";

describe("provider types", () => {
  it("lists every built-in provider with its label", () => {
    expect(PROVIDER_TYPES.map((entry) => entry.type)).toEqual(expect.arrayContaining(["openai", "elevenlabs", "fal"]));
    // A custom provider comes last, after the built-in ones by label.
    expect(PROVIDER_TYPES.at(-1)).toEqual({ type: "custom", label: "Custom provider" });
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("someday")).toBe("someday");
  });

  it("reads each type's operations from its description, marking live sessions", () => {
    const openai = operationsOf({ type: "openai" });
    expect(openai.find((operation) => operation.name === "openai.chat")).toEqual({ name: "openai.chat", session: false });
    expect(openai.find((operation) => operation.name === "openai.realtime")?.session).toBe(true);
    expect(operationsOf({ type: "nothing" })).toEqual([]);
  });

  it("adds passthrough for listed paths, and a custom provider's operation for each API style it lists", () => {
    expect(operationsOf({ type: "openai", passthrough: [{}] }).at(-1)).toEqual({ name: "passthrough", session: false });
    expect(operationsOf({ type: "openai", passthrough: [] }).some((operation) => operation.name === "passthrough")).toBe(false);
    expect(operationsOf({ type: "custom", passthrough: [{ style: "openai-chat" }, {}] })).toEqual([
      { name: "custom.openai-chat", session: false },
      { name: "passthrough", session: false },
    ]);
    expect(operationsOf({ type: "custom" })).toEqual([]);
  });
});
