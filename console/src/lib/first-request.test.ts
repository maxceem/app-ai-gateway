import { describe, expect, it } from "vitest";
import { firstRequest } from "./first-request";
import type { AppResponse, PricesResponse, ProviderCredential } from "./types";

const config = (policy: object = {}) => ({ resolved: { routing: {
  providerMode: "selected", providers: { custom: policy },
} } }) as unknown as AppResponse;
const provider = (type = "openai") => ({ slug: "custom", type, status: "active" }) as ProviderCredential;
const prices = { openai: { "text-model": { input: 1, output: 2 } } } as unknown as PricesResponse["prices"];

describe("first request examples", () => {
  it("uses the configured slug and catalog model for an unrestricted policy", () => {
    expect(firstRequest(config(), [provider()], prices)).toMatchObject({
      provider: "custom", path: "v1/responses", body: { model: "text-model", input: "Say hello." },
    });
  });
  it("honors an allowed path's fixed model and adds Anthropic's version header", () => {
    expect(firstRequest(config({ allowed_paths: [{ path: "v1/messages", fixed_model: "fixed-model" }] }), [provider("anthropic")], prices))
      .toMatchObject({ path: "v1/messages", anthropic: true, body: { model: "fixed-model", max_tokens: 128 } });
  });
  it("uses Groq's native prefix and an explicitly allowed model", () => {
    expect(firstRequest(config({ allowed_models: ["allowed-model"] }), [provider("groq")], prices))
      .toMatchObject({ path: "openai/v1/chat/completions", body: { model: "allowed-model" } });
  });
  it("does not invent a text request for an audio-only app or a disabled provider", () => {
    expect(firstRequest(config({ allowed_paths: ["v1/audio/transcriptions"] }), [provider()], prices)).toBeNull();
    expect(firstRequest(config(), [{ ...provider(), status: "disabled" }], prices)).toBeNull();
  });
});
