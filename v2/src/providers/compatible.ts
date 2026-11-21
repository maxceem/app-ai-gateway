/**
 * Today's other LLM providers (plan step 3): services that speak Chat
 * Completions, most with more APIs beside it (embeddings, images, speech).
 * Each is declared at its own paths, as v1's provider list serves them.
 * Transcription is declared for every provider at v1's paths by
 * `withV1Paths`.
 */
import { chat, completions, embeddings, images, messages, responses, speech, withV1Paths } from "./llm.ts";
import { defineProvider } from "./operation.ts";
import { NO_SERVICE_TIERS } from "../usage/service-modes.ts";

export const perplexity = defineProvider({
  type: "perplexity",
  label: "Perplexity",
  hosts: { main: "api.perplexity.ai" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // No probe: Perplexity has no free call that needs a key.
  cloudflareGateway: { slug: "perplexity-ai" },
  // `fast` is Perplexity's alias for priority.
  serviceModes: [
    {
      names: ["service_tier"],
      axis: "tier",
      values: { auto: "standard", default: "standard", standard: "standard", flex: "flex", priority: "priority", fast: "priority" },
    },
  ],
  operations: withV1Paths("perplexity", [
    chat("perplexity.chat", "chat/completions"),
    chat("perplexity.chat.v1", "v1/chat/completions"),
    responses("perplexity.agent", "v1/agent"),
    responses("perplexity.responses", "v1/responses"),
    chat("perplexity.router.chat", "router/v1/chat/completions"),
    responses("perplexity.router.responses", "router/v1/responses"),
    messages("perplexity.router.messages", "router/v1/messages"),
    embeddings("perplexity.embeddings", "v1/embeddings"),
    embeddings("perplexity.embeddings.contextualized", "v1/contextualizedembeddings"),
  ]),
});

export const deepseek = defineProvider({
  type: "deepseek",
  apiPrefixes: ["beta"],
  label: "DeepSeek",
  // DeepSeek's base URL has no `v1` segment; `v1/` is accepted as well.
  hosts: { main: "api.deepseek.com" },
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "models" },
  serviceModes: NO_SERVICE_TIERS,
  operations: withV1Paths("deepseek", [
    chat("deepseek.chat", "chat/completions"),
    chat("deepseek.chat.v1", "v1/chat/completions"),
    responses("deepseek.responses", "responses"),
    completions("deepseek.completions", "beta/completions"),
    messages("deepseek.messages", "anthropic/v1/messages"),
  ]),
});

export const groq = defineProvider({
  type: "groq",
  label: "Groq",
  // Groq's OpenAI-compatible API lives under `openai/v1/`.
  hosts: { main: "api.groq.com" },
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "openai/v1/models" },
  // `performance`, and `auto` which may be served from it, draw on reserved
  // capacity bought by contract, so they bill as standard.
  serviceModes: [
    {
      names: ["service_tier"],
      axis: "tier",
      values: { default: "standard", on_demand: "standard", flex: "flex", performance: "standard", auto: "standard" },
    },
  ],
  // Its `json` answer has no duration; `verbose_json` does, and extends it.
  transcriptionFormats: { metered: ["verbose_json"], default: "json", upgrades: { json: "verbose_json" } },
  operations: withV1Paths("groq", [
    chat("groq.chat", "openai/v1/chat/completions"),
    responses("groq.responses", "openai/v1/responses"),
    speech("groq.speech", "openai/v1/audio/speech"),
  ]),
});

export const mistral = defineProvider({
  type: "mistral",
  label: "Mistral",
  hosts: { main: "api.mistral.ai" },
  otherHosts: ["api.eu.mistral.ai", "api.us.mistral.ai"],
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "v1/models" },
  // `auto` asks for the Priority Tier wherever the account may use it.
  serviceModes: [{ names: ["service_tier"], axis: "tier", values: { standard_only: "standard", auto: "priority" } }],
  // `usage.service_tier` says whether the Priority Tier served the request.
  servedModes: [
    { names: ["service_tier"], axis: "tier", values: { standard: "standard", standard_only: "standard", priority: "priority" } },
  ],
  // Regional inference, 10% over the global host.
  regionalOrigins: { "https://api.eu.mistral.ai/": "eu", "https://api.us.mistral.ai/": "us" },
  operations: withV1Paths("mistral", [
    chat("mistral.chat", "v1/chat/completions"),
    completions("mistral.fim", "v1/fim/completions"),
    embeddings("mistral.embeddings", "v1/embeddings"),
    speech("mistral.speech", "v1/audio/speech"),
  ]),
});

export const together = defineProvider({
  type: "together",
  label: "Together AI",
  // `api.together.ai`, not the `.xyz` host older SDKs default to.
  hosts: { main: "api.together.ai" },
  otherHosts: ["us-api.together.ai", "api.together.xyz"],
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "v1/models" },
  serviceModes: NO_SERVICE_TIERS,
  // The US geo-pinned host, priced apart for the models it serves.
  regionalOrigins: { "https://us-api.together.ai/": "us" },
  // Its `json` answer has no duration; `verbose_json` does, and extends it.
  transcriptionFormats: { metered: ["verbose_json"], default: "json", upgrades: { json: "verbose_json" } },
  // Video is a job whose result is polled for, so it is not here.
  operations: withV1Paths("together", [
    chat("together.chat", "v1/chat/completions"),
    completions("together.completions", "v1/completions"),
    images("together.images", "v1/images/generations"),
    speech("together.speech", "v1/audio/speech"),
    embeddings("together.embeddings", "v1/embeddings"),
  ]),
});

export const fireworks = defineProvider({
  type: "fireworks",
  label: "Fireworks AI",
  // The inference plane is `inference/v1`; `v1` on the same host is the control plane.
  hosts: { main: "api.fireworks.ai" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // No probe: its list-models call needs the account id, which the key does not give.
  serviceModes: NO_SERVICE_TIERS,
  operations: withV1Paths("fireworks", [
    chat("fireworks.chat", "inference/v1/chat/completions"),
    completions("fireworks.completions", "inference/v1/completions"),
    messages("fireworks.messages", "inference/v1/messages"),
    responses("fireworks.responses", "inference/v1/responses"),
    embeddings("fireworks.embeddings", "inference/v1/embeddings"),
  ]),
});

export const cerebras = defineProvider({
  type: "cerebras",
  label: "Cerebras",
  hosts: { main: "api.cerebras.ai" },
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "v1/models" },
  // Its `priority`, `auto` and `flex` tiers run only on dedicated endpoints,
  // paid for by contract, so they bill as standard.
  serviceModes: [
    { names: ["service_tier"], axis: "tier", values: { default: "standard", priority: "standard", auto: "standard", flex: "standard" } },
  ],
  operations: withV1Paths("cerebras", [chat("cerebras.chat", "v1/chat/completions"), completions("cerebras.completions", "v1/completions")]),
});

/** Kimi's Chat Completions body has only the total cache write; its one-hour share is in a header of an answer that does not stream. */
const KIMI_CHAT = { usageHeaders: [{ header: "msh-usage-cache-write-tokens-1h", bucket: "cache_write", name: "1h" }] } as const;

export const moonshot = defineProvider({
  type: "moonshot",
  label: "Moonshot AI",
  // The international host. `api.moonshot.cn` is a separate platform.
  hosts: { main: "api.moonshot.ai" },
  // The China platform speaks the same API.
  otherHosts: ["api.moonshot.cn"],
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "v1/models" },
  serviceModes: NO_SERVICE_TIERS,
  operations: withV1Paths("moonshot", [chat("moonshot.chat", "v1/chat/completions", KIMI_CHAT), messages("moonshot.messages", "anthropic/v1/messages")], {
    chat: KIMI_CHAT,
  }),
});

export const huggingface = defineProvider({
  type: "huggingface",
  label: "Hugging Face",
  // The Inference Providers router. It has no price list of ours: the same
  // model costs very different amounts on its upstreams, so the customer
  // prices the models they use.
  hosts: { main: "router.huggingface.co" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // No probe: its model list is public and answers any token.
  serviceModes: NO_SERVICE_TIERS,
  operations: withV1Paths("huggingface", [chat("huggingface.chat", "v1/chat/completions")]),
});

export const baseten = defineProvider({
  type: "baseten",
  label: "Baseten",
  // The Model APIs inference host. `api.baseten.co` is the management plane.
  hosts: { main: "inference.baseten.co" },
  auth: { header: "authorization", format: "Bearer {key}" },
  probe: { path: "v1/models" },
  serviceModes: [{ names: ["service_tier"], axis: "tier", values: { default: "standard", flex: "flex", priority: "priority" } }],
  operations: withV1Paths("baseten", [chat("baseten.chat", "v1/chat/completions")]),
});

export const bytedance = defineProvider({
  type: "bytedance",
  label: "ByteDance Ark",
  // BytePlus ModelArk, the international edition: `api/v3` is its version
  // segment, so paths carry no `v1`. Other regions need the connection's own
  // base URL.
  hosts: { main: "ark.ap-southeast.bytepluses.com/api/v3" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // No probe: ModelArk has no list-models call, and answers every path with the same 401.
  serviceModes: [{ names: ["service_tier"], axis: "tier", values: { default: "standard", flex: "flex" } }],
  // The tier that served the request, which billing follows.
  servedModes: [{ names: ["response_service_tier"], axis: "tier", values: { default: "standard", flex: "flex" } }],
  // Seed models that hear price audio input apart, and report it as `audio_tokens`.
  countedInputModalities: ["audio"],
  // Seedream images bill per image; Seedance video is a polled job, so it is not here.
  operations: withV1Paths("bytedance", [
    chat("bytedance.chat", "chat/completions"),
    responses("bytedance.responses", "responses"),
    images("bytedance.images", "images/generations"),
    embeddings("bytedance.embeddings", "embeddings/multimodal"),
  ]),
});
