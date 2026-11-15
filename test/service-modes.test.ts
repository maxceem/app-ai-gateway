import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/core/errors";
import { parseServiceModeName, readServiceMode, serviceModeName, STANDARD_MODE } from "../src/shared/service-modes";
import { ProviderPricingSchema } from "../src/contracts/schemas";
import { providerDescriptor } from "../src/shared/providers";
import { computeCost, judgeServiceMode, priceInMode } from "../src/usage/pricing";
import { observeResponse } from "../src/usage/usage-readers";

const read = (body: Record<string, unknown>) => (name: string) => body[name];

/** The refusal requests will get once unpriced modes are refused rather than logged. */
function refusal(input: {
  type: Parameters<typeof judgeServiceMode>[0]["type"];
  route?: Parameters<typeof judgeServiceMode>[0]["route"];
  style?: Parameters<typeof judgeServiceMode>[0]["style"];
  body: Record<string, unknown>;
}) {
  return judgeServiceMode({
    type: input.type,
    route: input.route ?? "direct",
    style: input.style ?? "responses",
    model: "a-model",
    read: read(input.body),
    policy: "refuse",
  }).refusal;
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

describe("judgeServiceMode, when unpriced modes are refused", () => {
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

describe("priceInMode", () => {
  const price = {
    kind: "text" as const,
    input: 2,
    cached_input: 0.5,
    output: 8,
    long_input: 4,
    long_context_threshold: 200_000,
    modes: {
      flex: { factor: 0.5, cached_input: 0.25 },
      priority: { factor: 1.75 },
      eu: { factor: 1.1 },
      "priority+eu": { factor: 1.85 },
      us: { factor: 1.2 },
      "flex+gb": {},
    },
  };

  it("is the entry itself in the standard mode", () => {
    expect(priceInMode(price, STANDARD_MODE)).toBe(price);
  });

  it("multiplies every rate, long-context ones included, and keeps a rate the mode states", () => {
    expect(priceInMode(price, { tier: "flex", region: "global" }))
      .toMatchObject({ input: 1, cached_input: 0.25, output: 4, long_input: 2, long_context_threshold: 200_000 });
  });

  it("prefers a pair the provider prices apart over the product of its parts", () => {
    expect(priceInMode(price, { tier: "priority", region: "eu" })?.input).toBeCloseTo(3.7, 10);
    expect(priceInMode(price, { tier: "priority", region: "us" })?.input).toBeCloseTo(2 * 1.75 * 1.2, 10);
  });

  it("reads an entry with no factor as factor 1", () => {
    expect(priceInMode(price, { tier: "flex", region: "gb" })?.input).toBe(2);
  });

  it("has no price for a mode the entry does not list", () => {
    expect(priceInMode(price, { tier: "ultrafast", region: "global" })).toBeUndefined();
    expect(priceInMode(price, { tier: "fast", region: "eu" })).toBeUndefined();
    expect(priceInMode({ ...price, modes: undefined }, { tier: "flex", region: "global" })).toBeUndefined();
  });
});

describe("parseServiceModeName", () => {
  it.each([
    ["standard", { tier: "standard", region: "global" }],
    ["flex", { tier: "flex", region: "global" }],
    ["us", { tier: "standard", region: "us" }],
    ["priority+eu", { tier: "priority", region: "eu" }],
  ])("reads %s", (name, mode) => {
    expect(parseServiceModeName(name)).toEqual(mode);
  });

  it.each(["global", "eu+priority", "fast+us+eu", "turbo", "constructor", ""])("refuses %s", (name) => {
    expect(parseServiceModeName(name)).toBeNull();
  });
});

describe("mode prices in an override", () => {
  const override = (modes: unknown) => ProviderPricingSchema.safeParse({ "a-model": { input: 1, output: 2, modes } });

  it("accepts a factor, rates, regions and pairs", () => {
    expect(override({ flex: { factor: 0.5, cached_input: 0.1 }, us: { factor: 1.1 }, "fast+us": { factor: 2.2 } }).success)
      .toBe(true);
  });

  it.each([
    ["the standard mode", { standard: { factor: 1 } }],
    ["a name that is no mode", { turbo: { factor: 2 } }],
    ["a negative factor", { flex: { factor: -1 } }],
    ["a field that is no rate", { flex: { factor: 0.5, discount: 1 } }],
  ])("refuses %s", (_label, modes) => {
    expect(override(modes).success).toBe(false);
  });
});

describe("billing a served mode with no price", () => {
  const overrides = {
    "a-model": { input: 1, output: 4, modes: { fast: { factor: 2 }, us: { factor: 1.1 } } },
  };
  const usage = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 };

  it("bills the dearest price the model has, a composed pair included", () => {
    // fast in us, 2 × 1.1 on $0.005, is the dearest: never less than it.
    expect(computeCost("openai", "a-model", usage, overrides, { tier: "ultrafast", region: "us" }))
      .toBeCloseTo(0.011, 10);
  });

  it("searches only the axis that has no price", () => {
    // An unpriced region keeps the served tier: standard in eu bills at the
    // dearest priced region, us, never at fast.
    expect(computeCost("openai", "a-model", usage, overrides, { tier: "standard", region: "eu" }))
      .toBeCloseTo(0.0055, 10);
    // An unpriced tier keeps the served region.
    expect(computeCost("openai", "a-model", usage, overrides, { tier: "ultrafast", region: "global" }))
      .toBeCloseTo(0.01, 10);
  });

  it("bills a priced mode at its own price", () => {
    expect(computeCost("openai", "a-model", usage, overrides, { tier: "fast", region: "global" }))
      .toBeCloseTo(0.01, 10);
  });
});

describe("the served tier of a truncated response", () => {
  it("is kept beside the usage the tail still holds", () => {
    const observed = {
      head: '{"id":"resp_1","service_tier":"priority","output":[{"content":"',
      tail: '"}],"usage":{"input_tokens":10,"output_tokens":5}}',
      truncated: true,
    };
    const { usage } = observeResponse(observed, "application/json", "openai", "direct", "responses");
    expect(usage?.reportedModes).toEqual({ service_tier: "priority" });
  });
});
