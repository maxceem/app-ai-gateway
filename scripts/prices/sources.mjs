// Where each catalog provider's prices are checked, and the only
// hand-maintained part of the price sync (scripts/update-prices.mjs).
//
//   official   the provider's own page or API, and the parser written for it
//   modelsDev  the provider key at https://models.dev/api.json
//   litellm    the key a catalog model id has in LiteLLM's price file
//   aliases    catalog model id → the id the official source uses for it
//
// A provider with no `official` source, or whose parser fails, is checked
// against the two lists instead, and only updated when they agree.

import { parseAnthropic } from "./parsers/anthropic.mjs";
import { parseCerebras } from "./parsers/cerebras.mjs";
import { parseDeepseek } from "./parsers/deepseek.mjs";
import { parseGemini } from "./parsers/gemini.mjs";
import { parseGroq } from "./parsers/groq.mjs";
import { parseMoonshot } from "./parsers/moonshot.mjs";
import { parseOpenai } from "./parsers/openai.mjs";
import { parsePerplexity } from "./parsers/perplexity.mjs";
import { parseTogether } from "./parsers/together.mjs";
import { parseXai } from "./parsers/xai.mjs";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const MARKDOWN = "text/markdown";

export const SOURCES = {
  openai: {
    official: {
      url: "https://developers.openai.com/api/docs/pricing.md",
      type: MARKDOWN,
      parse: parseOpenai,
    },
    modelsDev: "openai",
    litellm: (id) => id,
    aliases: { "whisper-1": "Whisper" },
  },
  anthropic: {
    official: {
      url: "https://platform.claude.com/docs/en/about-claude/pricing.md",
      type: MARKDOWN,
      parse: parseAnthropic,
    },
    modelsDev: "anthropic",
    litellm: (id) => id,
    aliases: { "claude-haiku-4-5-20251001": "claude-haiku-4-5" },
  },
  gemini: {
    official: {
      url: "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
      type: MARKDOWN,
      parse: parseGemini,
    },
    modelsDev: "google",
    litellm: (id) => `gemini/${id}`,
  },
  xai: {
    official: { url: "https://docs.x.ai/developers/pricing.md", type: MARKDOWN, parse: parseXai },
    modelsDev: "xai",
    litellm: (id) => `xai/${id}`,
    aliases: { "grok-transcribe": "Speech to Text" },
  },
  together: {
    official: {
      url: "https://docs.together.ai/docs/serverless-models.md",
      type: MARKDOWN,
      parse: parseTogether,
    },
    modelsDev: "togetherai",
    litellm: (id) => `together_ai/${id}`,
  },
  groq: {
    official: { url: "https://console.groq.com/docs/models.md", type: MARKDOWN, parse: parseGroq },
    modelsDev: "groq",
    litellm: (id) => `groq/${id}`,
  },
  moonshot: {
    official: {
      url: "https://platform.moonshot.ai/docs/pricing/chat.md",
      type: MARKDOWN,
      parse: parseMoonshot,
    },
    modelsDev: "moonshotai",
    litellm: (id) => `moonshot/${id}`,
  },
  deepseek: {
    official: {
      url: "https://api-docs.deepseek.com/quick_start/pricing",
      type: "text/html",
      parse: parseDeepseek,
    },
    modelsDev: "deepseek",
    litellm: (id) => `deepseek/${id}`,
    // Retired name, still accepted and billed as deepseek-flash.
    aliases: { "deepseek-v4-flash": "deepseek-flash" },
  },
  perplexity: {
    official: {
      url: "https://docs.perplexity.ai/getting-started/pricing.md",
      type: MARKDOWN,
      parse: parsePerplexity,
    },
    modelsDev: "perplexity",
    litellm: (id) => `perplexity/${id}`,
  },
  cerebras: {
    official: {
      url: "https://api.cerebras.ai/public/v1/models",
      type: "application/json",
      parse: parseCerebras,
    },
    modelsDev: "cerebras",
    litellm: (id) => `cerebras/${id}`,
  },
  mistral: {
    modelsDev: "mistral",
    litellm: (id) => `mistral/${id}`,
  },
  baseten: {
    modelsDev: "baseten",
    litellm: (id) => `baseten/${id}`,
  },
  bytedance: {
    // ByteDance's models are sold through Volcengine.
    modelsDev: "volcengine",
    litellm: (id) => `volcengine/${id}`,
  },
};

/** The id the official source uses for a catalog model. */
export function officialId(provider, model) {
  return SOURCES[provider]?.aliases?.[model] ?? model;
}
