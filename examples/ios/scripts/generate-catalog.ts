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

type Price = Record<string, unknown> & { kind?: string; retirement_date?: string };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const prices = JSON.parse(readFileSync(join(root, "src/usage/models.json"), "utf8")) as Record<
  string,
  Record<string, Price>
>;
const today = new Date().toISOString().slice(0, 10);

/** What the demo does with a model, from the kind the catalog gives it. */
function kind(price: Price): "chat" | "transcription" | "image" | "voice" | undefined {
  // Speech and embedding models are not something the demo shows.
  switch (price.kind) {
    case "text": return "chat";
    case "image": return "image";
    case "transcription": return "transcription";
    // A realtime conversation is billed by its text and audio tokens. A
    // realtime model priced by the minute, such as live transcription, is not
    // one the gateway holds a conversation with.
    case "realtime": return price.audio_output === undefined ? undefined : "voice";
    default: return undefined;
  }
}

const providers = PROVIDER_TYPES.map((type) => {
  const entry = { type, label: providerDescriptor(type).label, chat: [] as string[], transcription: [] as string[], image: [] as string[], voice: [] as string[] };
  for (const [id, price] of Object.entries(prices[type] ?? {})) {
    if (price.retirement_date && price.retirement_date <= today) continue;
    const k = kind(price);
    if (k) entry[k].push(id);
  }
  return entry;
});

const out = join(here, "../GatewayDemo/Resources/catalog.json");
writeFileSync(out, `${JSON.stringify({ providers }, null, 2)}\n`);
console.log(`Wrote ${out}`);
