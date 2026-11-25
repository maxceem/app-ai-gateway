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
  // Every place a request names a model, or lets OpenRouter choose one, is
  // judged, or refused when it cannot be (src/proxy/alternatives.ts). The
  // refusals hold only where the app lists its models or a preset fixes
  // one: with no limit there is nothing to get around.
  // - `models` is a fallback list, tried after `model`, and `fallbacks` its
  //   Anthropic Messages spelling: each model is judged, and the one the
  //   answer names is charged (docs: guides/routing/model-fallbacks);
  // - a router has OpenRouter pick the model. Its own list of allowed
  //   models takes patterns, under its plugin's id, so the gateway reads no
  //   candidates: a router the app lists is the customer's choice and is
  //   served; one it does not list is refused (docs:
  //   guides/routing/routers/overview, .../auto-router);
  // - a `preset` field that loads a preset (`@preset/...`; a bare slug is
  //   ignored) brings a saved model, fallback list and tools; a server tool
  //   that calls another model (an advisor, a subagent, a fusion panel,
  //   image generation) may name one, default to one, or let the model pick
  //   it; the `fusion` plugin names a panel and an analyst (docs:
  //   guides/features/presets, .../server-tools, .../plugins/fusion). All
  //   are refused. Tool types have aliases, such as Anthropic's
  //   `advisor_20260301`, so a type is matched by the words it contains.
  // A `model` that is itself a preset (`@preset/...`) or a variant
  // (`...:nitro`) is judged as written: served where the app lists it.
  alternativeModels: {
    paths: ["models[]", "fallbacks[].model"],
    choosingAmong: [],
    refusedWhen: [
      { path: "preset", containing: ["@preset/"] },
      { path: "tools[].type", containing: ["advisor", "subagent", "fusion", "image"] },
      // A plugin sent with `enabled: false` is turned off (docs: guides/features/plugins).
      { path: "plugins[].id", containing: ["fusion"], unless: { field: "enabled", value: false } },
    ],
  },
  choosingModels: [
    "openrouter/auto",
    "openrouter/auto-beta",
    "openrouter/auto-code",
    "openrouter/free",
    "openrouter/pareto-code",
    "openrouter/fusion",
    "nvidia/switchyard",
    "typesafe/jev-router",
  ],
  operations: withV1Paths("openrouter",[chat("openrouter.chat", "v1/chat/completions", { providerCost: "openrouter" })], {
    styles: ["chat"],
    chat: { providerCost: "openrouter" },
  }),
});
