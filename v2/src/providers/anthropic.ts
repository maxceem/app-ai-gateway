/** Anthropic: the Messages API. */
import { messages, withV1Paths } from "./llm.ts";
import { defineProvider } from "./operation.ts";

export const anthropic = defineProvider({
  type: "anthropic",
  label: "Anthropic",
  hosts: { main: "api.anthropic.com" },
  auth: { header: "x-api-key", format: "{key}" },
  // Anthropic refuses any request without a version header, the key test
  // included. On live traffic the version is the client's own, sent by every
  // SDK, so it is never set there.
  probe: { path: "v1/models", headers: { "anthropic-version": "2023-06-01" } },
  // Through Cloudflare, Messages takes `x-api-key` and the OpenAI-compatible
  // Chat Completions a bearer token, each as Cloudflare documents it.
  cloudflareGateway: { slug: "anthropic", authByStyle: { "openai-chat": { header: "authorization", format: "Bearer {key}" } } },
  // Fast mode is `speed`, and the region is `inference_geo`. `service_tier`
  // draws on a Priority Tier commitment paid for by contract, so it bills as
  // standard.
  serviceModes: [
    { names: ["speed"], axis: "tier", values: { standard: "standard", fast: "fast" } },
    { names: ["service_tier"], axis: "tier", values: { auto: "standard", standard_only: "standard" } },
    { names: ["inference_geo"], axis: "region", values: { global: "global", us: "us" } },
  ],
  // `usage` names the speed and the region that served the request. A
  // request that asked for no region reports `inference_geo: "not_available"`
  // (seen on real calls, T27): it names no region, so the asked one stands.
  servedModes: [
    { names: ["speed"], axis: "tier", values: { standard: "standard", fast: "fast" } },
    { names: ["service_tier"], axis: "tier", values: { standard: "standard", priority: "standard", batch: "standard" } },
    { names: ["inference_geo"], axis: "region", values: { global: "global", us: "us" }, unstated: ["not_available"] },
  ],
  operations: withV1Paths("anthropic", [messages("anthropic.messages", "v1/messages")]),
});
