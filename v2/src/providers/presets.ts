/**
 * Which declared operations a preset can use (plan section 4.4).
 *
 * A preset's request is built by the gateway, never from the client's path,
 * so its operation must be one whose path the gateway can fill in alone: a
 * call measured from its answer, sent as a POST, whose path has no part other
 * than its model. Fallbacks may only link operations of the same API style
 * (section 4.1), so one usage reader reads whichever answers.
 *
 * Shared by saving an app (strict) and serving a preset (forgiving), so the
 * two never disagree on what a preset can be.
 */
import { BUILT_IN_PROVIDERS } from "./index.ts";
import { ProviderMatcher } from "./matcher.ts";
import type { ApiStyle, OperationDescription, ProviderDescription } from "./operation.ts";

const matchers = new Map<string, ProviderMatcher>();

function matcherOf(description: ProviderDescription): ProviderMatcher {
  let matcher = matchers.get(description.type);
  if (matcher === undefined) {
    matcher = new ProviderMatcher(description);
    matchers.set(description.type, matcher);
  }
  return matcher;
}

/** A declared operation by its name, which is unique across all providers. */
export function declaredOperation(name: string): OperationDescription | null {
  for (const description of Object.values(BUILT_IN_PROVIDERS)) {
    const found = description.operations.find((operation) => operation.name === name);
    if (found !== undefined) return found;
  }
  return null;
}

/** Why `operation` of `description` cannot serve a preset, or null when it can. */
export function presetOperationProblem(description: ProviderDescription, operation: OperationDescription): string | null {
  if (operation.lifecycle !== "call" || operation.meter.kind !== "response_json" || operation.style === undefined) {
    return `${operation.name} cannot be a preset: only calls measured from their answer can be`;
  }
  if (operation.match.method !== "POST") return `${operation.name} cannot be a preset: it is not a POST`;
  const location = operation.model;
  if (location.in !== "body" && location.in !== "form" && location.in !== "path") {
    return `${operation.name} cannot be a preset: it names no model the preset could set`;
  }
  const parts = matcherOf(description).templateParts(operation.name) ?? [];
  const extra = parts.filter((part) => location.in !== "path" || part !== location.part);
  if (extra.length > 0) return `${operation.name} cannot be a preset: its path has parts other than the model`;
  return null;
}

/**
 * The operation a preset target uses on a connection of this type: the named
 * one, or the first declared one of `style`. Null when there is none that
 * can serve a preset, or the named one speaks another style.
 */
export function presetOperation(
  description: ProviderDescription,
  style: ApiStyle,
  name: string | undefined,
): OperationDescription | null {
  const candidates =
    name === undefined
      ? description.operations.filter((operation) => operation.style === style)
      : description.operations.filter((operation) => operation.name === name);
  return (
    candidates.find((operation) => operation.style === style && presetOperationProblem(description, operation) === null) ?? null
  );
}

/**
 * Gemini's streaming method for a `generateContent` operation, as a preset
 * called with `?alt=sse` asks for (v1): the operation of the same style at
 * the same path with `:streamGenerateContent`. Null when there is none.
 */
export function streamingSibling(description: ProviderDescription, operation: OperationDescription): OperationDescription | null {
  const path = operation.match.path;
  if (!path.endsWith(":generateContent")) return null;
  const streaming = path.replace(/:generateContent$/u, ":streamGenerateContent");
  return description.operations.find((candidate) => candidate.style === operation.style && candidate.match.path === streaming) ?? null;
}

/** The path a preset target is sent to, with its model filled in where the path names it. */
export function presetUpstream(
  description: ProviderDescription,
  operation: OperationDescription,
  model: string,
): { readonly host: string; readonly path: string } | null {
  const location = operation.model;
  return matcherOf(description).upstreamFor(operation.name, location.in === "path" ? { [location.part]: model } : {});
}
