import { describe, expect, it } from "vitest";
import { served } from "@/test/providers";
import { pricingNote } from "./pricing-dialog";

describe("pricing note", () => {
  it("tells a provider that reports nothing that unpriced models are refused", () => {
    expect(pricingNote({ type: "openai", ...served("openai") }))
      .toBe("Requests for unpriced models are rejected until a price is set here.");
  });

  it("says a provider reporting on every API it serves needs no price", () => {
    expect(pricingNote({ type: "openrouter", ...served("openrouter") }))
      .toMatch(/^OpenRouter reports the cost of every request/u);
  });

  it("names the APIs a partly reporting provider covers, and says the rest need a price", () => {
    const note = pricingNote({ type: "xai", ...served("xai") });
    expect(note).toMatch(
      /^xAI reports the cost of each Responses, Chat Completions, and provider-native request/u,
    );
    expect(note).toMatch(/Its other APIs still need a price\.$/u);
  });

  it("treats a route that does not relay the provider's answers as reporting nothing", () => {
    expect(pricingNote({ type: "xai", ...served("xai", "vercel") }))
      .toBe("Requests for unpriced models are rejected until a price is set here.");
  });
});
