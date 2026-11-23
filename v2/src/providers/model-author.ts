/**
 * Who made a model, for the charges read (`model_author`), as v1
 * (`resolveModelAuthor` at the repository root). An analytics field only: it
 * never affects a price, a limit or an allowlist.
 *
 * In order:
 * 1. the price list's `author` for the model;
 * 2. for a provider whose model ids start with their author's namespace
 *    (`authorNamespacedModels`, an aggregator's: `meta-llama/…`), that namespace;
 * 3. the one author every model of the provider has (`modelAuthor`), where there is one.
 *
 * Each provider declares its own (`./operation.ts`), so nothing here names one.
 *
 * An unknown namespace, or a custom provider, is no answer: null, never a guess.
 */
import { listPrice } from "../pricing/prices.ts";
import { builtInProvider } from "./index.ts";

/** Namespaces in an aggregator's model ids, and who they mean. */
const AUTHOR_NAMESPACES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "meta-llama": "Meta",
  meta: "Meta",
  qwen: "Alibaba",
  alibaba: "Alibaba",
  deepseek: "DeepSeek",
  mistralai: "Mistral",
  mistral: "Mistral",
  "x-ai": "xAI",
  xai: "xAI",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
  zai: "Z.ai",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  tencent: "Tencent",
  "bytedance-seed": "ByteDance",
  bytedance: "ByteDance",
  cohere: "Cohere",
  amazon: "Amazon",
  perplexity: "Perplexity",
  microsoft: "Microsoft",
  baidu: "Baidu",
  "ibm-granite": "IBM",
  upstage: "Upstage",
  stepfun: "StepFun",
  xiaomi: "Xiaomi",
  liquid: "Liquid AI",
  writer: "Writer",
  "arcee-ai": "Arcee AI",
  nousresearch: "Nous Research",
  thinkingmachines: "Thinking Machines",
  rekaai: "Reka",
  sakana: "Sakana AI",
};

export function modelAuthor(providerType: string, model: string | null): string | null {
  if (model === null || model === "") return null;
  const listed = listPrice(providerType, model)?.raw.author;
  if (typeof listed === "string" && listed !== "") return listed;
  const provider = builtInProvider(providerType);
  if (provider?.authorNamespacedModels === true) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      const author = AUTHOR_NAMESPACES[model.slice(0, slash).replace(/^~/u, "").toLowerCase()];
      if (author !== undefined) return author;
    }
    return null;
  }
  return provider?.modelAuthor ?? null;
}
