import type { AppResponse, PricesResponse, ProviderCredential } from "./types";

/** Use the saved policy and catalog so the snippet needs no invented model or path. */
export function firstRequest(config: AppResponse, providers: ProviderCredential[], prices: PricesResponse["prices"]) {
  const routing = config.resolved?.routing;
  if (!routing) return null;
  for (const provider of providers) {
    if (provider.status !== "active") continue;
    const policy = routing.providers?.[provider.slug];
    if (routing.providerMode === "selected" && !policy) continue;
    const models = policy?.allowed_models?.length ? policy.allowed_models : [
      ...Object.keys(provider.pricing ?? {}),
      ...Object.entries(prices[provider.type] ?? {}).filter(([, price]) => price.output !== undefined).map(([model]) => model),
    ];
    const defaultPath = provider.type === "openai" ? "v1/responses"
      : provider.type === "anthropic" ? "v1/messages"
      : provider.type === "gemini" ? `v1beta/models/${models[0]}:generateContent`
      : !provider.providerGatewayId && provider.type === "groq" ? "openai/v1/chat/completions"
      : !provider.providerGatewayId && provider.type === "fireworks" ? "inference/v1/chat/completions"
      : !provider.providerGatewayId && ["deepseek", "bytedance"].includes(provider.type) ? "chat/completions"
      : "v1/chat/completions";
    const paths = policy?.allowed_paths?.length ? policy.allowed_paths : [defaultPath];
    for (const entry of paths) {
      const path = typeof entry === "string" ? entry : entry.path;
      if (path.includes("*")) continue;
      const model = typeof entry !== "string" && entry.fixed_model ? entry.fixed_model : models[0];
      if (!model) continue;
      const messages = [{ role: "user", content: "Say hello." }];
      const body = path.endsWith("responses") ? { model, input: "Say hello." }
        : path.endsWith("chat/completions") ? { model, messages }
        : path.endsWith("messages") ? { model, max_tokens: 128, messages }
        : path.endsWith(":generateContent") ? { contents: [{ parts: [{ text: "Say hello." }] }] }
        : null;
      if (body) return { provider: provider.slug, path, body, anthropic: path.endsWith("messages") };
    }
  }
  return null;
}
