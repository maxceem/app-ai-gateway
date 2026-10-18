// Writes GatewayDemo/Resources/catalog.json: the models the demo's picker
// offers, sorted by what each one does, from the gateway's own price catalog.
//
//   node --experimental-strip-types examples/ios/scripts/generate-catalog.ts
//
// The catalog lists the models the gateway can price per provider type. It
// does not know which providers your account has connected, or which models an
// app allows: the demo's settings choose the providers, and the gateway refuses
// a model the app does not allow with `403 model_not_allowed`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_TYPES, providerDescriptor } from "../../../src/shared/providers.ts";

type Price = Record<string, unknown> & { retirement_date?: string };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const prices = JSON.parse(readFileSync(join(root, "src/usage/models.json"), "utf8")) as Record<
  string,
  Record<string, Price>
>;
const today = new Date().toISOString().slice(0, 10);

function kind(id: string, price: Price): "chat" | "transcription" | "image" | undefined {
  // Realtime and live models speak a WebSocket protocol, embeddings and speech
  // are not something the demo shows.
  if (/realtime|live|embedding|tts/.test(id)) return undefined;
  if ("per_minute" in price || "per_hour" in price || /transcribe|whisper/.test(id)) return "transcription";
  if ("per_image" in price || "image_output" in price || /image|banana|seedream/.test(id)) return "image";
  if ("input" in price && "output" in price) return "chat";
  return undefined;
}

const providers = PROVIDER_TYPES.map((type) => {
  const entry = { type, label: providerDescriptor(type).label, chat: [] as string[], transcription: [] as string[], image: [] as string[] };
  for (const [id, price] of Object.entries(prices[type] ?? {})) {
    if (price.retirement_date && price.retirement_date <= today) continue;
    const k = kind(id, price);
    if (k) entry[k].push(id);
  }
  return entry;
});

const out = join(here, "../GatewayDemo/Resources/catalog.json");
writeFileSync(out, `${JSON.stringify({ providers }, null, 2)}\n`);
console.log(`Wrote ${out}`);
