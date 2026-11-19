/**
 * Compile-time checks of `defineOperation`. This file is never run: the
 * typecheck (`pnpm run check`) fails if a line marked `@ts-expect-error` stops
 * being an error, or if a good declaration stops compiling.
 */
import { defineOperation } from "../src/providers/operation.ts";

const base = { lifecycle: "call", transport: "http", meter: { kind: "request_count" } } as const;

// Good: a path part, a model read from it, and an upstream template using it.
defineOperation({
  ...base,
  name: "good.part",
  match: { method: "POST", path: "v1/voices/{voice_id}/speak" },
  upstream: { path: "v2/speak/{voice_id}" },
  model: { in: "path", part: "voice_id" },
});

// Good: a `{name...}` part with its closed list.
defineOperation({
  ...base,
  name: "good.multi",
  match: { method: "POST", path: "run/{model...}" },
  multiSegment: { model: ["fal-ai/flux/dev"] },
  model: { in: "path", part: "model" },
});

defineOperation({
  ...base,
  name: "bad.model_part",
  match: { method: "POST", path: "v1/voices/{voice_id}" },
  // @ts-expect-error The model is read from a part the path does not have.
  model: { in: "path", part: "model" },
});

// @ts-expect-error A `{name...}` part without its closed list.
defineOperation({
  ...base,
  name: "bad.multi_without_list",
  match: { method: "POST", path: "run/{model...}" },
  model: { in: "path", part: "model" },
});

defineOperation({
  ...base,
  name: "bad.two_multi",
  match: { method: "POST", path: "{owner...}/x/{model...}" },
  // @ts-expect-error A template can have only one `{name...}` part.
  multiSegment: { owner: ["a"], model: ["b"] },
  model: { in: "fixed", model: "m" },
});

defineOperation({
  ...base,
  name: "bad.upstream_part",
  match: { method: "POST", path: "v1/voices/{voice_id}" },
  // @ts-expect-error The upstream template uses a part the match template does not have.
  upstream: { path: "v1/voices/{voice}" },
  model: { in: "fixed", model: "m" },
});

defineOperation({
  ...base,
  name: "bad.list_without_multi",
  match: { method: "POST", path: "v1/voices/{voice_id}" },
  // @ts-expect-error A closed list for a template with no `{name...}` part.
  multiSegment: { voice_id: ["a"] },
  model: { in: "fixed", model: "m" },
});
