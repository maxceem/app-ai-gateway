import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/core/errors";
import { readServiceMode, serviceModeName } from "../src/shared/service-modes";
import { providerDescriptor } from "../src/shared/providers";
import { serviceModeRefusal } from "../src/usage/pricing";

const read = (body: Record<string, unknown>) => (name: string) => body[name];

/** The refusal requests will get once unpriced modes are refused rather than logged. */
function refusal(input: {
  type: Parameters<typeof serviceModeRefusal>[0]["type"];
  route?: Parameters<typeof serviceModeRefusal>[0]["route"];
  style?: Parameters<typeof serviceModeRefusal>[0]["style"];
  body: Record<string, unknown>;
}) {
  return serviceModeRefusal({
    type: input.type,
    route: input.route ?? "direct",
    style: input.style ?? "responses",
    model: "a-model",
    read: read(input.body),
    policy: "refuse",
  });
}

describe("readServiceMode", () => {
  it("reads nothing as the standard mode", () => {
    expect(serviceModeName(readServiceMode(providerDescriptor("openai").serviceModes, read({})).mode)).toBe("standard");
  });

  it("keeps the dearest tier any field or spelling asks for", () => {
    const { mode } = readServiceMode(
      providerDescriptor("gemini").serviceModes,
      read({ service_tier: "flex", serviceTier: "priority" }),
    );
    expect(mode.tier).toBe("priority");
  });

  it("reads flex, which the standard default must not shadow", () => {
    expect(readServiceMode(providerDescriptor("openai").serviceModes, read({ service_tier: "flex" })).mode.tier)
      .toBe("flex");
  });

  it("follows a dotted name into nested objects, and nowhere else", () => {
    const fields = [{ names: ["a.b"], axis: "tier", values: { fast: "fast" } }] as const;
    expect(readServiceMode(fields, read({ a: { b: "fast" } })).mode.tier).toBe("fast");
    expect(readServiceMode(fields, read({ a: [{ b: "fast" }] })).mode.tier).toBe("standard");
    expect(readServiceMode(fields, read({ a: "b" })).mode.tier).toBe("standard");
    expect(readServiceMode(fields, read({ a: {} })).mode.tier).toBe("standard");
  });

  it("names an unknown value only as a short token", () => {
    const fields = providerDescriptor("openai").serviceModes;
    expect(readServiceMode(fields, read({ service_tier: "turbo" })).unknown)
      .toEqual({ field: "service_tier", value: "turbo" });
    expect(readServiceMode(fields, read({ service_tier: "a value with spaces" })).unknown)
      .toEqual({ field: "service_tier", value: "(other)" });
  });
});

describe("serviceModeRefusal, when unpriced modes are refused", () => {
  it.each([
    ["OpenAI fast", "openai", { service_tier: "priority" }, "fast"],
    ["Anthropic fast mode in the US", "anthropic", { speed: "fast", inference_geo: "us" }, "fast+us"],
    ["Mistral's priority-when-eligible", "mistral", { service_tier: "auto" }, "priority"],
    ["flex, which no price lists yet", "openai", { service_tier: "flex" }, "flex"],
  ] as const)("refuses %s with the mode it names", (_label, type, body, mode) => {
    const error = refusal({ type, body });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status: 400, code: "pricing_not_configured", data: { service_mode: mode } });
  });

  it.each([
    ["standard", "openai", { service_tier: "default" }],
    ["a tier paid for by contract", "groq", { service_tier: "performance" }],
  ] as const)("lets %s through", (_label, type, body) => {
    expect(refusal({ type, body })).toBeNull();
  });

  it("quotes the fields the client sent, and says how to add the price", () => {
    expect(refusal({ type: "anthropic", style: "anthropic_messages", body: { speed: "fast", inference_geo: "us" } }))
      .toMatchObject({
        message: 'Model a-model has no price on anthropic in service mode fast+us, which the request asks for with '
          + 'speed: "fast", inference_geo: "us". Add a price for that mode under custom model pricing in the provider '
          + "settings, or leave speed and inference_geo out.",
        data: { service_mode: "fast+us", field: "speed" },
      });
  });

  it("lets an unknown value through, and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(refusal({ type: "deepseek", style: "chat_completions", body: { service_tier: "turbo" } })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("service_mode_unknown"));
    warn.mockRestore();
  });

  it("lets any mode through where the provider reports what it cost", () => {
    expect(refusal({ type: "xai", body: { service_tier: "priority" } })).toBeNull();
    expect(refusal({ type: "xai", style: "anthropic_messages", body: { service_tier: "priority" } }))
      .toMatchObject({ data: { service_mode: "priority" } });
  });

  it("reads a gateway's own fields on its route", () => {
    const body = { providerOptions: { gateway: { serviceTier: "priority" } } };
    expect(refusal({ type: "openai", body })).toBeNull();
    expect(refusal({ type: "openai", route: "vercel", body })).toMatchObject({ data: { service_mode: "priority" } });
  });
});
