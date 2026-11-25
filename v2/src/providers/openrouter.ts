/**
 * OpenRouter. An aggregator, billed by what it reports: every Chat
 * Completions answer carries `usage.cost`, what OpenRouter charged. No price
 * list covers its hundreds of models, so its other APIs, whose answers do not
 * report a cost, are not declared (v1).
 */
import { chat, withV1Paths } from "./llm.ts";
import { defineProvider } from "./operation.ts";

export const openrouter = defineProvider({
  type: "openrouter",
  authorNamespacedModels: true,
  label: "OpenRouter",
  hosts: { main: "openrouter.ai/api" },
  // Its in-region hosts (docs: guides/features/in-region-routing).
  otherHosts: ["us.openrouter.ai/api", "eu.openrouter.ai/api"],
  auth: { header: "authorization", format: "Bearer {key}" },
  // Its key-status call: `v1/models` is public and answers any token.
  probe: { path: "v1/key" },
  // `priority` and `fast` are one tier there, named fast on OpenAI's models.
  serviceModes: [
    {
      names: ["service_tier"],
      axis: "tier",
      values: { default: "standard", standard: "standard", flex: "flex", priority: "priority", fast: "fast", ultrafast: "ultrafast" },
    },
  ],
  // Its plain fallback lists name more models it may answer with, each
  // judged as `model` is, and the one that answered is charged (docs:
  // guides/routing/model-fallbacks). Its other features (routers, saved
  // presets, plugins, server tools) are passed through unchecked: a router
  // or an `@preset/...` name is a plain model name the app's list allows or
  // not, and every call is charged at the cost OpenRouter reports.
  alternativeModels: { paths: ["models[]", "fallbacks[].model"] },
  operations: withV1Paths("openrouter", [chat("openrouter.chat", "v1/chat/completions", { providerCost: "openrouter" })], {
    styles: ["chat"],
    chat: { providerCost: "openrouter" },
  }),
});
