import { describe, expect, it } from "vitest";
import { validateAppConfigJson } from "../src/core/config";
import { serverConfig } from "./helpers";

describe("canonical app configuration", () => {
  it("accepts explicit all-provider mode", () => {
    expect(() => validateAppConfigJson(serverConfig())).not.toThrow();
  });

  it("allows selected mode without a provider to disable all providers", () => {
    const config = serverConfig() as any;
    config.routing.providers = { mode: "selected", selected: {} };
    expect(() => validateAppConfigJson(config)).not.toThrow();
  });

  it.each([
    ["unset", { allowed_paths: [], allowed_models: [] }],
    ["set", { allowed_paths: [], allowed_models: [], max_output_tokens: 8192 }],
  ])("accepts max_output_tokens when %s", (_label, openai) => {
    expect(() => validateAppConfigJson(serverConfig({ proxy: { openai } }))).not.toThrow();
  });

  it.each([0, -1, 1.5, "8192"])('rejects invalid max_output_tokens value %s', (value) => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { openai: { allowed_paths: [], allowed_models: [], max_output_tokens: value } },
    }))).toThrowError("openai.max_output_tokens");
  });

  it("rejects missing discriminators instead of inferring legacy defaults", () => {
    expect(() => validateAppConfigJson({ authentication: {}, routing: {}, limits: {} }))
      .toThrowError("authentication.type");
  });

  it("rejects allowlisted and fixed models without provider pricing", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["released-today"] },
      },
    }))).toThrowError("has no configured price");
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        xai: {
          allowed_paths: [{ path: "v1/stt", fixed_model: "released-today" }],
          allowed_models: [],
        },
      },
    }))).toThrowError("has no configured price");
  });

  it("accepts an unpriced client alias when it rewrites to a priced provider model", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["client-alias"] },
        model_rewrites: { "client-alias": "gpt-5.6-sol" },
      },
    }))).not.toThrow();
  });

  it("rejects rewrite targets that are absent from every price catalog", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { alias: "released-today" } },
    }))).toThrowError("has no configured price");
  });
});
