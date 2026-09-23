/**
 * A provider type is one object in `src/shared/providers.ts`; this module is
 * what the Worker asks that object questions with — the header a call
 * authenticates with, the extra headers a call or a probe carries, who made a
 * model. The descriptors themselves are shared with the console, so nothing
 * below may need anything a browser build cannot have.
 */

import type { CostReport } from "../shared/cost-report";
import { providerDescriptor, type ProviderType } from "../shared/providers";

/**
 * Model-slug namespaces to the lab that made the model, for the provider types
 * whose IDs carry one. Verified against OpenRouter's live model list rather
 * than guessed: an unlisted namespace resolves to no author, which the console
 * shows as unknown, and a wrong one would silently mis-attribute spend.
 *
 * Alias slugs are published with a leading `~` (`~anthropic/claude-opus-latest`),
 * which {@link namespaceModelAuthor} strips before looking a namespace up.
 */
const MODEL_AUTHOR_NAMESPACES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "meta-llama": "Meta",
  meta: "Meta",
  qwen: "Alibaba",
  deepseek: "DeepSeek",
  mistralai: "Mistral",
  "x-ai": "xAI",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
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

/**
 * How this provider type reports its own cost, or `null` where it does not.
 * The single question generic code asks: it never learns whose fields the
 * returned integration reads.
 */
export function costReport(type: ProviderType): CostReport | null {
  return providerDescriptor(type).costReport ?? null;
}

/** The author every model of this provider type has, when there is one. */
export function providerModelAuthor(type: ProviderType): string | null {
  return providerDescriptor(type).modelAuthor ?? null;
}

/**
 * Who made a model, read off the namespace in its own ID. Only for the types
 * whose IDs are declared to carry one: `meta-llama/…` means Meta on OpenRouter,
 * while another host's leading segment could mean an account, a region, or its
 * own name. An unknown namespace is no answer, never a guess.
 */
export function namespaceModelAuthor(type: ProviderType, model: string): string | null {
  if (providerDescriptor(type).authorNamespacedModels !== true) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const namespace = model.slice(0, slash).replace(/^~/u, "").toLowerCase();
  return MODEL_AUTHOR_NAMESPACES[namespace] ?? null;
}

/**
 * Non-auth headers this provider type needs on every direct call, the
 * descriptor's own and its cost-report integration's together. One list, so the
 * sanitizer strips a client's version of every one of them without knowing
 * which declared it.
 */
export function providerRequestHeaders(type: ProviderType): Readonly<Record<string, string>> {
  const descriptor = providerDescriptor(type);
  const declared = descriptor.requestHeaders;
  const reporting = descriptor.costReport?.requestHeaders;
  if (!reporting) return declared ?? {};
  return declared ? { ...declared, ...reporting } : reporting;
}

/** Non-auth headers this provider type's credential probe has to carry. */
export function providerProbeHeaders(type: ProviderType): Readonly<Record<string, string>> {
  return providerDescriptor(type).probeHeaders ?? {};
}

/** The credential header value a direct call to this provider carries. */
export function providerAuthValue(type: ProviderType, secret: string): string {
  const { auth } = providerDescriptor(type);
  return `${auth.scheme ?? ""}${secret}`;
}
