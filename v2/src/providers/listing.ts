/**
 * Which provider type a model is read as: for its price in our list, and for
 * its service-mode tables. A provider's own model is read as itself. A model
 * of a gateway that serves other providers' models (`modelNamespaces`, Vercel
 * AI Gateway) is read as the provider its namespace names: `openai/gpt-4o` is
 * OpenAI's `gpt-4o`. The one place this mapping is applied, so pricing and
 * service modes always agree on it.
 */
import { builtInProvider } from "./index.ts";

export interface ListedModel {
  readonly type: string;
  readonly model: string;
}

/** The provider type and model id `model` of a `type` connection is listed under. */
export function listedAs(type: string, model: string): ListedModel {
  return listedIn(builtInProvider(type)?.modelNamespaces, type, model);
}

/** The same, with the namespaces given: an operation's own (`readingRules`), such as a custom provider's path on Vercel's host. */
export function listedIn(namespaces: Readonly<Record<string, string>> | undefined, type: string, model: string): ListedModel {
  if (namespaces === undefined) return { type, model };
  const slash = model.indexOf("/");
  const namespace = slash > 0 ? model.slice(0, slash) : "";
  const rest = slash > 0 ? model.slice(slash + 1) : "";
  if (rest.length === 0 || !Object.hasOwn(namespaces, namespace)) return { type, model };
  return { type: namespaces[namespace]!, model: rest };
}
