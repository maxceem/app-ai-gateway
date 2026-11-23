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
import { CUSTOM_OPERATIONS } from "./custom.ts";
import { BUILT_IN_PROVIDERS } from "./index.ts";
import { ProviderMatcher } from "./matcher.ts";
import type { ApiStyle, OperationDescription, ProviderDescription } from "./operation.ts";

/** By description: a custom provider's is built per connection (`../providers/custom.ts`), and all share one type. */
const matchers = new WeakMap<ProviderDescription, ProviderMatcher>();

function matcherOf(description: ProviderDescription): ProviderMatcher {
  let matcher = matchers.get(description);
  if (matcher === undefined) {
    matcher = new ProviderMatcher(description);
    matchers.set(description, matcher);
  }
  return matcher;
}

/**
 * A declared operation by its name, which is unique across all providers: a
 * built-in one, or a custom provider's operation of an API style
 * (`./custom.ts`), whatever path a connection lists it at.
 */
export function declaredOperation(name: string): OperationDescription | null {
  for (const description of Object.values(BUILT_IN_PROVIDERS)) {
    const found = description.operations.find((operation) => operation.name === name);
    if (found !== undefined) return found;
  }
  return CUSTOM_OPERATIONS.find((operation) => operation.name === name) ?? null;
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

/** A preset as its shape is judged: what the contract's preset holds. */
export interface PresetShape {
  readonly provider: string;
  readonly operation: string;
  readonly model: string;
  readonly params?: unknown;
  readonly max_output_tokens?: number | undefined;
  readonly fallback?: readonly { readonly provider: string; readonly operation?: string | undefined; readonly model: string }[] | undefined;
}

/** A connection as a preset's shape needs it: its type, and its description (null when the type is not supported). */
export interface PresetConnection {
  readonly type: string;
  readonly description: ProviderDescription | null;
}

/** One target a preset tries: the preset itself (`where` is "") or a fallback (`fallback.<n>`), with the operation it uses. */
export interface PresetTarget {
  readonly where: string;
  readonly provider: string;
  readonly model: string;
  readonly connection: PresetConnection;
  readonly operation: OperationDescription;
}

/**
 * Whether a preset has a shape the gateway can serve, by the rules the
 * gateway saves it with, shared with the console so the two never differ:
 * its operation is one a preset can use; parameters only for a JSON request;
 * each target's connection exists and is supported, and has an operation of
 * the preset's API style a preset can use (the named one, when a target names
 * one); and an output cap only where the operation has output to cap.
 *
 * `connection` gives a connection by slug, or null when there is none. A
 * problem names its field inside the preset, such as `fallback.0.operation`.
 */
export function presetShape(
  preset: PresetShape,
  connection: (slug: string) => PresetConnection | null,
): { readonly ok: true; readonly style: ApiStyle; readonly declared: OperationDescription; readonly targets: readonly PresetTarget[] } | { readonly ok: false; readonly path: string; readonly message: string } {
  const declared = declaredOperation(preset.operation);
  const style = declared?.style;
  if (declared === null || style === undefined) return { ok: false, path: "operation", message: `${preset.operation} is not an operation a preset can use` };
  if (preset.params !== undefined && declared.model.in === "form") {
    return { ok: false, path: "params", message: `a ${style} preset takes an upload; params apply only to JSON requests` };
  }
  const listed = [
    { where: "", provider: preset.provider, operation: preset.operation as string | undefined, model: preset.model },
    ...(preset.fallback ?? []).map((fallback, index) => ({ where: `fallback.${index}`, ...fallback })),
  ];
  const targets: PresetTarget[] = [];
  for (const [index, target] of listed.entries()) {
    const at = (field: string) => (target.where === "" ? field : `${target.where}.${field}`);
    const found = connection(target.provider);
    if (found === null) return { ok: false, path: at("provider"), message: `no provider connection ${target.provider} exists` };
    const description = found.description;
    if (description === null) return { ok: false, path: at("provider"), message: `provider type ${found.type} is not supported` };
    const operation = presetOperation(description, style, target.operation);
    if (operation === null) {
      const named = target.operation === undefined ? undefined : description.operations.find((candidate) => candidate.name === target.operation);
      if (target.operation === undefined) return { ok: false, path: at("provider"), message: `${found.type} has no ${style} operation a preset can use` };
      return {
        ok: false,
        path: at("operation"),
        message:
          named === undefined
            ? `${target.operation} is not an operation of ${found.type}`
            : named.style !== style
              ? `${target.operation} is not a ${style} operation; a fallback must speak the preset's API style`
              : (presetOperationProblem(description, named) ?? `${target.operation} cannot be a preset`),
      };
    }
    if (index === 0 && preset.max_output_tokens !== undefined && operation.policy?.outputCap === undefined) {
      return { ok: false, path: "max_output_tokens", message: `${operation.name} has no output to cap` };
    }
    targets.push({ where: target.where, provider: target.provider, model: target.model, connection: found, operation });
  }
  return { ok: true, style, declared, targets };
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

/**
 * A copy of a request body an attempt can change: the top level, and Gemini's
 * `generationConfig`, which the output cap writes into. Everything below them
 * is shared, never copied, so a long chain never holds many copies of a
 * large request.
 */
export function attemptCopy(body: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  const config = body.generationConfig;
  if (typeof config === "object" && config !== null && !Array.isArray(config)) copy.generationConfig = { ...config };
  return copy;
}
