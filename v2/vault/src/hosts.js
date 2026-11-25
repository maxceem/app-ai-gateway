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
 * The only headers a built-in provider type's key may be sent in: the ones
 * the provider descriptions name for keys (`auth`, and Cloudflare AI
 * Gateway's `authByStyle`). Any other header, such as `origin`, could be
 * echoed back in an answer with the key in it, so the vault refuses it. A test
 * in the gateway fails when this list and the descriptions differ.
 */
export const BUILT_IN_KEY_HEADERS = Object.freeze(["authorization", "x-api-key", "x-goog-api-key", "xi-api-key"]);
