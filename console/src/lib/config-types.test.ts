import { describe, expect, it } from "vitest";
import {
  enabledProviders,
  emptyEndpoint,
  emptyProvider,
  endpointSlugError,
  nextEndpointSlug,
  providerMode,
  renameEndpoint,
  type EndpointsConfig,
} from "./config-types";

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

describe("named endpoint editing", () => {
  const endpoints: EndpointsConfig = {
    chat: { api_style: "responses", provider: "openai", model: "gpt-5.6-luna" },
    transcribe: { api_style: "transcription", provider: "openai", model: "gpt-4o-mini-transcribe" },
  };

  it("starts a new endpoint on the responses style with no model chosen", () => {
    expect(emptyEndpoint()).toEqual({ api_style: "responses", provider: "openai", model: "" });
  });

  it("never suggests a slug that would replace an existing endpoint", () => {
    expect(nextEndpointSlug({})).toBe("endpoint");
    expect(nextEndpointSlug({ endpoint: emptyEndpoint() })).toBe("endpoint-2");
    expect(nextEndpointSlug({ endpoint: emptyEndpoint(), "endpoint-2": emptyEndpoint() }))
      .toBe("endpoint-3");
  });

  it("renames a slug in place so cards keep their order", () => {
    expect(Object.entries(renameEndpoint(endpoints, "chat", "assistant")).map(([slug]) => slug))
      .toEqual(["assistant", "transcribe"]);
    expect(renameEndpoint(endpoints, "chat", "assistant").assistant).toEqual(endpoints.chat);
  });

  it("reports the same slug rules the Worker enforces", () => {
    expect(endpointSlugError("chat", endpoints, "chat")).toBeNull();
    expect(endpointSlugError("Chat", endpoints, "chat")).toContain("a-z");
    expect(endpointSlugError("", endpoints, "chat")).toContain("a-z");
    expect(endpointSlugError("a".repeat(65), endpoints, "chat")).toContain("a-z");
    expect(endpointSlugError("transcribe", endpoints, "chat")).toContain("already uses this slug");
  });
});
