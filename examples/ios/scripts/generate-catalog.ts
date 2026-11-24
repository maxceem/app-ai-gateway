// Writes GatewayDemo/Resources/catalog.json: the models the demo's picker
// offers, sorted by what each one does, from the gateway's own price catalog.
//
//   node --experimental-strip-types examples/ios/scripts/generate-catalog.ts
//
// The catalog lists the models the v2 gateway can price per provider type. It
// does not know which providers your account has connected, or which models an
// app allows: the demo's settings choose the providers, and the gateway refuses
// a model the app does not allow with `403 model_not_allowed`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_PROVIDERS } from "../../../v2/src/providers/index.ts";
import { providerTypes } from "../../../v2/src/providers/provider-types.ts";

type Price = Record<string, unknown> & { kind?: string; retirement_date?: string };
type PriceFile = Record<string, Record<string, Price>>;

const here = dirname(fileURLToPath(import.meta.url));
const pricing = join(here, "../../../v2/src/pricing");
const read = (name: string) => JSON.parse(readFileSync(join(pricing, name), "utf8")) as PriceFile;
// v2 prices with v1's file plus its own overlay, where v1's entry wins
// (`v2/src/pricing/price-file.ts`).
const prices: PriceFile = read("models.json");
for (const [provider, entries] of Object.entries(read("models.v2.json"))) {
  const target = (prices[provider] ??= {});
  for (const [model, entry] of Object.entries(entries)) if (!Object.hasOwn(target, model)) target[model] = entry;
}
const today = new Date().toISOString().slice(0, 10);

/** What the demo does with a model, from the kind the catalog gives it. */
function kind(price: Price): "chat" | "transcription" | "image" | undefined {
  // Speech, embeddings and realtime models are not something the demo shows.
  switch (price.kind) {
    case "text": return "chat";
    case "image": return "image";
    case "transcription": return "transcription";
    default: return undefined;
  }
}

// The demo chats with every provider it lists, so only the ones that serve a
// chat API style are listed, in the gateway's own order. Perplexity is left
// out: most of its priced models are other makers' (`google/…`, `openai/…`),
// which Perplexity serves on its Agent and Orchestrator APIs, not on the
// `chat/completions` the demo sends to.
const LEFT_OUT = new Set(["perplexity"]);
/** Image models the demo cannot use: they edit an image it never sends. */
const NEEDS_SOURCE_IMAGE = new Set(["seededit-3-0-i2i-250628"]);
const order = Object.keys(BUILT_IN_PROVIDERS);
const chatting = providerTypes()
  .filter((provider) => !provider.custom && !LEFT_OUT.has(provider.type))
  .filter((provider) => provider.styles.some((style) => style === "openai-chat" || style === "anthropic-messages"))
  .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

const providers = chatting.map(({ type, label }) => {
  const entry = { type, label, chat: [] as string[], transcription: [] as string[], image: [] as string[] };
  for (const [id, price] of Object.entries(prices[type] ?? {})) {
    if (price.retirement_date && price.retirement_date <= today) continue;
    const k = kind(price);
    if (k === "image" && NEEDS_SOURCE_IMAGE.has(id)) continue;
    if (k) entry[k].push(id);
  }
  return entry;
});

const out = join(here, "../GatewayDemo/Resources/catalog.json");
writeFileSync(out, `${JSON.stringify({ providers }, null, 2)}\n`);
console.log(`Wrote ${out}`);
