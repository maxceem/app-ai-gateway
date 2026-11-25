// @ts-check
/**
 * Where a key sealed for "the provider's own address" (`baseUrl` "") may go:
 * each built-in provider type's own hosts, as its description in the gateway
 * declares them (`hosts` only, never `otherHosts`). A host may carry the
 * API's path, as the descriptions do.
 *
 * The only catalog data in the vault. A test in the gateway fails when this
 * table and the provider descriptions differ, and a new built-in host needs a
 * vault deploy.
 */
export const PROVIDER_HOSTS = Object.freeze({
  anthropic: ["api.anthropic.com"],
  baseten: ["inference.baseten.co"],
  bytedance: ["ark.ap-southeast.bytepluses.com/api/v3"],
  cerebras: ["api.cerebras.ai"],
  deepgram: ["api.deepgram.com"],
  deepseek: ["api.deepseek.com"],
  elevenlabs: ["api.elevenlabs.io"],
  fal: ["fal.run", "queue.fal.run"],
  fireworks: ["api.fireworks.ai"],
  gemini: ["generativelanguage.googleapis.com"],
  groq: ["api.groq.com"],
  huggingface: ["router.huggingface.co"],
  mistral: ["api.mistral.ai"],
  moonshot: ["api.moonshot.ai"],
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai/api"],
  perplexity: ["api.perplexity.ai"],
  together: ["api.together.ai"],
  vercel: ["ai-gateway.vercel.sh"],
  xai: ["api.x.ai"],
});

/**
 * The headers each built-in provider type's key may be sent in: the ones its
 * description names for keys (`auth`, and Cloudflare AI Gateway's
 * `authByStyle`). Any other header could be echoed back in an answer with the
 * key in it, or passed on by a host that runs other people's apps (fal), so
 * the vault refuses it. A test in the gateway fails when this table and the
 * descriptions differ.
 */
export const KEY_HEADERS = Object.freeze({
  anthropic: ["authorization", "x-api-key"],
  baseten: ["authorization"],
  bytedance: ["authorization"],
  cerebras: ["authorization"],
  deepgram: ["authorization"],
  deepseek: ["authorization"],
  elevenlabs: ["xi-api-key"],
  fal: ["authorization"],
  fireworks: ["authorization"],
  gemini: ["x-goog-api-key"],
  groq: ["authorization"],
  huggingface: ["authorization"],
  mistral: ["authorization"],
  moonshot: ["authorization"],
  openai: ["authorization"],
  openrouter: ["authorization"],
  perplexity: ["authorization"],
  together: ["authorization"],
  vercel: ["authorization"],
  xai: ["authorization"],
});

/**
 * Each built-in type's path in Cloudflare AI Gateway's address space. A key
 * sealed for a Cloudflare AI Gateway goes only under its own provider's path
 * there, never another provider's (AI Gateway passes `/fal/...` on to fal). A
 * type with no path here is not sent through AI Gateway. A test in the
 * gateway fails when this table and the descriptions differ.
 */
export const CLOUDFLARE_SLUGS = Object.freeze({
  anthropic: "anthropic",
  gemini: "google-ai-studio",
  openai: "openai",
  perplexity: "perplexity-ai",
  xai: "grok",
});
