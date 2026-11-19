import { describe, expect, it } from "vitest";
import { operationsOf, PROVIDER_TYPES, providerLabel } from "./providers";

describe("provider types", () => {
  it("lists every built-in provider with its label", () => {
    expect(PROVIDER_TYPES.map((entry) => entry.type)).toEqual(expect.arrayContaining(["openai", "elevenlabs", "fal"]));
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("someday")).toBe("someday");
  });

  it("reads each type's operations from its description, marking live sessions", () => {
    const openai = operationsOf("openai");
    expect(openai.find((operation) => operation.name === "openai.chat")).toEqual({ name: "openai.chat", session: false });
    expect(openai.find((operation) => operation.name === "openai.realtime")?.session).toBe(true);
    expect(operationsOf("nothing")).toEqual([]);
  });
});
