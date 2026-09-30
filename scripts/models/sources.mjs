// Where each catalog provider's prices and retirement dates are checked, and
// the only hand-maintained part of the model sync (scripts/update-models.mjs).
//
//   official      the provider's own pricing page or API, and its parser
//   deprecations  the provider's own deprecation table, and its parser
//   modelsDev     the provider key at https://models.dev/api.json
//   litellm       the key a catalog model id has in LiteLLM's price file
//
// Either source may carry `aliases`: catalog model id → the id that page uses.
// A provider with no official source, or whose parser fails, is checked
// against the two lists instead, and only updated when they agree.
//
// Only deprecation pages that are tables are read. Providers that announce
// retirements in prose (Cerebras, DeepSeek, Perplexity) are left to the lists.

import { parseAnthropic } from "./parsers/anthropic.mjs";
import { parseAnthropicDeprecations } from "./parsers/anthropic-deprecations.mjs";
import { parseCerebras } from "./parsers/cerebras.mjs";
import { parseDeepseek } from "./parsers/deepseek.mjs";
import { parseGemini } from "./parsers/gemini.mjs";
import { parseGeminiDeprecations } from "./parsers/gemini-deprecations.mjs";
import { parseGroq } from "./parsers/groq.mjs";
import { parseGroqDeprecations } from "./parsers/groq-deprecations.mjs";
import { parseMoonshot } from "./parsers/moonshot.mjs";
import { parseOpenai } from "./parsers/openai.mjs";
import { parseOpenaiDeprecations } from "./parsers/openai-deprecations.mjs";
import { parsePerplexity } from "./parsers/perplexity.mjs";
import { parseTogether } from "./parsers/together.mjs";
import { parseTogetherDeprecations } from "./parsers/together-deprecations.mjs";
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
      aliases: { "whisper-1": "Whisper" },
    },
    deprecations: {
      url: "https://developers.openai.com/api/docs/deprecations.md",
      type: MARKDOWN,
      parse: parseOpenaiDeprecations,
    },
    modelsDev: "openai",
    litellm: (id) => id,
  },
  anthropic: {
    official: {
      url: "https://platform.claude.com/docs/en/about-claude/pricing.md",
      type: MARKDOWN,
      parse: parseAnthropic,
      aliases: { "claude-haiku-4-5-20251001": "claude-haiku-4-5" },
    },
    deprecations: {
      url: "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
      type: MARKDOWN,
      parse: parseAnthropicDeprecations,
      // The deprecation table names the dated snapshot an alias points at.
      aliases: {
        "claude-opus-4-5": "claude-opus-4-5-20251101",
        "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5": "claude-haiku-4-5-20251001",
      },
    },
    modelsDev: "anthropic",
    litellm: (id) => id,
  },
  gemini: {
    official: {
      url: "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
      type: MARKDOWN,
      parse: parseGemini,
    },
    deprecations: {
      url: "https://ai.google.dev/gemini-api/docs/deprecations.md.txt",
      type: MARKDOWN,
      parse: parseGeminiDeprecations,
    },
    modelsDev: "google",
    litellm: (id) => `gemini/${id}`,
  },
  xai: {
    official: {
      url: "https://docs.x.ai/developers/pricing.md",
      type: MARKDOWN,
      parse: parseXai,
      aliases: { "grok-transcribe": "Speech to Text" },
    },
    modelsDev: "xai",
    litellm: (id) => `xai/${id}`,
  },
  together: {
    official: {
      url: "https://docs.together.ai/docs/serverless-models.md",
      type: MARKDOWN,
      parse: parseTogether,
    },
    deprecations: {
      url: "https://docs.together.ai/docs/deprecations.md",
      type: MARKDOWN,
      parse: parseTogetherDeprecations,
    },
    modelsDev: "togetherai",
    litellm: (id) => `together_ai/${id}`,
  },
  groq: {
    official: { url: "https://console.groq.com/docs/models.md", type: MARKDOWN, parse: parseGroq },
    deprecations: {
      url: "https://console.groq.com/docs/deprecations.md",
      type: MARKDOWN,
      parse: parseGroqDeprecations,
    },
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
      // Retired name, still accepted and billed as deepseek-flash.
      aliases: { "deepseek-v4-flash": "deepseek-flash" },
    },
    modelsDev: "deepseek",
    litellm: (id) => `deepseek/${id}`,
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

/** The id a source (`official` or `deprecations`) uses for a catalog model. */
export function sourceId(source, model) {
  return source?.aliases?.[model] ?? model;
}
