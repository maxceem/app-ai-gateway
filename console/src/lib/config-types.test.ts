import { describe, expect, it } from "vitest";
import { enabledProviders, emptyProvider, providerMode } from "./config-types";

describe("provider configuration defaults", () => {
  it("creates an unrestricted provider until an operator enters an output cap", () => {
    expect(emptyProvider()).toEqual({
      allowed_paths: [],
      allowed_models: [],
    });
  });

  it("uses explicit all-provider mode", () => {
    const proxy = { providers: { mode: "all" as const }, model_rewrites: {} };
    expect(providerMode(proxy)).toBe("all");
    expect(enabledProviders(proxy)).toEqual([
      "openai",
      "anthropic",
      "xai",
      "gemini",
      "perplexity",
    ]);
  });

  it("uses providers nested under selected mode", () => {
    const proxy = {
      providers: { mode: "selected" as const, selected: { openai: emptyProvider() } },
      model_rewrites: {},
    };
    expect(providerMode(proxy)).toBe("selected");
    expect(enabledProviders(proxy)).toEqual(["openai"]);
  });

  it("can explicitly select no providers", () => {
    const proxy = { providers: { mode: "selected" as const, selected: {} }, model_rewrites: {} };
    expect(providerMode(proxy)).toBe("selected");
    expect(enabledProviders(proxy)).toEqual([]);
  });
});
