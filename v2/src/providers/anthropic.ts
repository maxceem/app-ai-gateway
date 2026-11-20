/** Anthropic: the Messages API. */
import { messages } from "./llm.ts";
import { defineProvider } from "./operation.ts";

export const anthropic = defineProvider({
  type: "anthropic",
  label: "Anthropic",
  hosts: { main: "api.anthropic.com" },
  auth: { header: "x-api-key", format: "{key}" },
  // Admin keys, workspaces, users, invites and usage reports.
  refused: ["v1/organizations/*"],
  // Anthropic refuses any request without a version header, the key test
  // included. On live traffic the version is the client's own, sent by every
  // SDK, so it is never set there.
  probe: { path: "v1/models", headers: { "anthropic-version": "2023-06-01" } },
  // Fast mode is `speed`, and the region is `inference_geo`. `service_tier`
  // draws on a Priority Tier commitment paid for by contract, so it bills as
  // standard.
  serviceModes: [
    { names: ["speed"], axis: "tier", values: { standard: "standard", fast: "fast" } },
    { names: ["service_tier"], axis: "tier", values: { auto: "standard", standard_only: "standard" } },
    { names: ["inference_geo"], axis: "region", values: { global: "global", us: "us" } },
  ],
  // `usage` names the speed and the region that served the request.
  servedModes: [
    { names: ["speed"], axis: "tier", values: { standard: "standard", fast: "fast" } },
    { names: ["service_tier"], axis: "tier", values: { standard: "standard", priority: "standard", batch: "standard" } },
    { names: ["inference_geo"], axis: "region", values: { global: "global", us: "us" } },
  ],
  operations: [messages("anthropic.messages", "v1/messages")],
});
