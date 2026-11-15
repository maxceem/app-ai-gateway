import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServiceModeName, readServiceMode, serviceModeName, STANDARD_MODE } from "../src/shared/service-modes";
import { ProviderPricingSchema } from "../src/contracts/schemas";
import { providerDescriptor } from "../src/shared/providers";
import { computeCost, configuredModeProblem, judgeServiceMode, priceInMode } from "../src/usage/pricing";
import { observeResponse } from "../src/usage/usage-readers";

const read = (body: Record<string, unknown>) => (name: string) => body[name];

/** The mode a request asks `type` for, judged against a model priced by `pricing`, if any. */
function judged(input: {
  type: Parameters<typeof judgeServiceMode>[0]["type"];
  route?: Parameters<typeof judgeServiceMode>[0]["route"];
  style?: Parameters<typeof judgeServiceMode>[0]["style"];
  baseUrl?: string;
  pricing?: Parameters<typeof judgeServiceMode>[0]["pricing"];
  body: Record<string, unknown>;
}) {
  return judgeServiceMode({
    type: input.type,
    route: input.route ?? "direct",
    style: input.style ?? "responses",
    baseUrl: input.baseUrl,
    pricing: input.pricing,
    model: "a-model",
    read: read(input.body),
  });
}

const PRICED = { "a-model": { input: 1, output: 4, modes: { fast: { factor: 2 } } } };

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

describe("judgeServiceMode", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never refuses a mode with no price: it is served and estimated", () => {
    expect(judged({ type: "openai", body: { service_tier: "flex" } }))
      .toEqual({ mode: { tier: "flex", region: "global" }, estimated: true });
    expect(judged({ type: "mistral", style: "chat_completions", body: { service_tier: "auto" } }).estimated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("service_mode_unpriced"));
  });

  it("bills a priced mode exactly", () => {
    expect(judged({ type: "openai", pricing: PRICED, body: { service_tier: "priority" } }))
      .toEqual({ mode: { tier: "fast", region: "global" }, estimated: false });
    expect(judged({ type: "openai", body: { service_tier: "default" } }).estimated).toBe(false);
  });

  it("estimates a value the gateway does not know, and logs it", () => {
    expect(judged({ type: "deepseek", style: "chat_completions", body: { service_tier: "turbo" } }))
      .toEqual({ mode: STANDARD_MODE, estimated: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("service_mode_unknown"));
  });

  it("estimates nothing where the provider reports what each request cost", () => {
    expect(judged({ type: "xai", body: { service_tier: "priority" } }).estimated).toBe(false);
    expect(judged({ type: "xai", style: "anthropic_messages", body: { service_tier: "priority" } }).estimated).toBe(true);
  });

  it("reads a gateway's own fields on its route, and the region of a regional base URL", () => {
    const body = { providerOptions: { gateway: { serviceTier: "priority" } } };
    expect(judged({ type: "openai", body }).mode).toEqual(STANDARD_MODE);
    expect(judged({ type: "openai", route: "vercel", body }).mode).toEqual({ tier: "priority", region: "global" });
    expect(judged({ type: "together", style: "chat_completions", baseUrl: "https://us-api.together.ai/", body: {} }).mode)
      .toEqual({ tier: "standard", region: "us" });
  });
});

describe("configuredModeProblem", () => {
  const problem = (body: Record<string, unknown>, pricing?: typeof PRICED, type: "openai" | "xai" = "openai") =>
    configuredModeProblem({ type, route: "direct", pricing, style: "responses", model: "a-model", read: read(body) });

  it("refuses a mode the parameters name with no price, quoting them and saying how to add it", () => {
    expect(problem({ service_tier: "flex" })).toBe(
      'Model a-model has no price on openai in service mode flex, which the parameters set with service_tier: "flex". '
        + "Add a price for that mode under custom model pricing in the provider settings, or leave service_tier out of the parameters.",
    );
  });

  it("accepts a priced mode, a value the gateway does not know, and any mode on a route that reports its cost", () => {
    expect(problem({ service_tier: "priority" }, PRICED)).toBeNull();
    expect(problem({ service_tier: "turbo" })).toBeNull();
    expect(problem({ service_tier: "priority" }, undefined, "xai")).toBeNull();
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
