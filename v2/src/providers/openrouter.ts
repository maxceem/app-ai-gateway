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
  label: "OpenRouter",
  hosts: { main: "openrouter.ai/api" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // Key management (and the OAuth exchange that creates a key), the key's own
  // limits, the account's credits and activity, and its organization settings.
  refused: ["v1/keys/*", "v1/key/*", "v1/auth/*", "v1/credits/*", "v1/activity/*", "v1/organization/*", "v1/guardrails/*"],
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
  operations: withV1Paths("openrouter", [chat("openrouter.chat", "v1/chat/completions", { providerCost: "openrouter" })], {
    styles: ["chat"],
    chat: { providerCost: "openrouter" },
  }),
});
