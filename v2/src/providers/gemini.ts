/**
 * Gemini: its own `generateContent` and `embedContent`, with the model in the
 * path, and its OpenAI-compatible Chat Completions. `generateContent` also
 * carries image, speech and transcription models.
 */
import { chat, DETACHED, withV1Paths } from "./llm.ts";
import { defineOperation, defineProvider } from "./operation.ts";

/** `generateContent` and its streaming twin, under one API version. */
function generate(version: "v1" | "v1beta" | "v1alpha") {
  const common = {
    lifecycle: "call",
    transport: "stream",
    style: "gemini-generate",
    policy: { outputCap: "gemini" },
    background: DETACHED,
    meter: { kind: "response_json", style: "gemini-generate" },
  } as const;
  return [
    defineOperation({
      ...common,
      name: `gemini.generate.${version}`,
      match: { method: "POST", path: `${version}/models/{model}:generateContent` },
      model: { in: "path", part: "model" },
    }),
    defineOperation({
      ...common,
      name: `gemini.stream.${version}`,
      match: { method: "POST", path: `${version}/models/{model}:streamGenerateContent` },
      model: { in: "path", part: "model" },
    }),
  ];
}

/**
 * `embedContent` under one API version. `batchEmbedContents` is left out, as
 * in v1: each item may name a model the one in the path does not.
 */
function embed(version: "v1" | "v1beta") {
  return defineOperation({
    name: `gemini.embed.${version}`,
    match: { method: "POST", path: `${version}/models/{model}:embedContent` },
    lifecycle: "call",
    transport: "http",
    style: "gemini-embed",
    model: { in: "path", part: "model" },
    meter: { kind: "response_json", style: "gemini-embed" },
  });
}

export const gemini = defineProvider({
  type: "gemini",
  label: "Gemini",
  hosts: { main: "generativelanguage.googleapis.com" },
  auth: { header: "x-goog-api-key", format: "{key}" },
  // Tuned models and stored files belong to the key's project, not to a call.
  refused: ["v1beta/tunedModels/*", "v1/tunedModels/*"],
  probe: { path: "v1beta/models" },
  // Gemini's REST surface accepts both spellings of a field.
  serviceModes: [
    { names: ["service_tier", "serviceTier"], axis: "tier", values: { standard: "standard", flex: "flex", priority: "priority" } },
  ],
  // The tier that served the request is in a response header, and in
  // `usageMetadata.serviceTier`: priority over its limit is served, and
  // billed, as standard.
  servedModes: [
    {
      names: ["header:x-gemini-service-tier", "serviceTier"],
      axis: "tier",
      values: { standard: "standard", flex: "flex", priority: "priority" },
    },
  ],
  operations: withV1Paths("gemini", [
    ...generate("v1beta"),
    ...generate("v1"),
    ...generate("v1alpha"),
    embed("v1beta"),
    embed("v1"),
    chat("gemini.chat", "v1beta/openai/chat/completions"),
  ]),
});
