/**
 * The one table of names a credential goes by, and the one way a field name
 * is compared with it, for both directions of the MCP server: an argument
 * with one of these names is refused before anything reads it, and a result
 * field with one of these names is shown as {@link REDACTED}.
 *
 * Names are compared whole after lower-casing and dropping `_` and `-`, so
 * `Token`, `api_key`, `apiKey` and `API-KEY` all match, and `secretHint`,
 * `tokenHint` or `max_tokens` — which are not credentials — never do.
 */

import { AppKeyMetadataSchema } from "../contracts/responses";

export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "secret",
  "token",
  "apikey",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "bearertoken",
  "clientsecret",
  "apisecret",
  "secretkey",
  "privatekey",
]);

/** What a result shows in place of a value whose field is named like a credential. */
export const REDACTED = "[redacted]";

/** A field name as the table compares it: lower case, without `_` or `-`. */
export function normalisedFieldName(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, "");
}

/** Whether a field, a query parameter or a header is named like a credential. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELDS.has(normalisedFieldName(name));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The path of the first field anywhere in `value` named like a credential, or null. */
export function secretField(value: unknown, path: string[] = []): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretField(item, [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (isSecretFieldName(key)) return [...path, key].join(".");
    const found = secretField(item, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The fields of the one object a credential-named field may hold and still be
 * shown: an app key's metadata, `api_key: {id, name, key_prefix, created_at}`,
 * which change tools answer in place of the key. Read off the response schema,
 * so the exemption follows the contract and cannot outgrow it.
 */
const APP_KEY_METADATA_FIELDS: ReadonlySet<string> = new Set(Object.keys(AppKeyMetadataSchema.shape));

/** A path into a result, field by field, such as `["result", "api_key"]`. */
export type ResultPath = readonly string[];

/**
 * Whether `value` has the shape of an app key's metadata: an object whose
 * every field is one the metadata schema names, each holding a plain value.
 * Shape alone proves nothing about where a value came from, so this is asked
 * only at a path where the tool itself puts a key it created.
 */
function isAppKeyMetadata(value: unknown): boolean {
  return isObject(value)
    && Object.entries(value).every(([field, item]) =>
      APP_KEY_METADATA_FIELDS.has(field) && (item === null || typeof item !== "object"));
}

function samePath(left: ResultPath, right: ResultPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * A copy of a result in which every field named like a credential is
 * {@link REDACTED} — the whole field, whatever it holds: a string, a number,
 * a list or an object — at any depth. A field holding nothing (`null`) stays
 * as it is.
 *
 * The one exemption is positional: `keyMetadataAt` names the exact paths at
 * which the tool answers the metadata of an app key it created — `api_key` of
 * a create, `result.api_key` of an operation's status — and an object there is
 * kept when it has the metadata's shape. Anywhere else, an app document stored
 * through the API included, an `api_key` is redacted like any other
 * credential-named field, whatever it looks like.
 *
 * Applied to what a tool answers, whatever wrote it: an app document stored
 * through the API may carry provider-native parameters of any name.
 */
export function redactSecrets<T>(value: T, keyMetadataAt: readonly ResultPath[] = [], path: ResultPath = []): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecrets(item, keyMetadataAt, [...path, String(index)])) as T;
  }
  if (!isObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const at = [...path, key];
    const kept = !isSecretFieldName(key)
      || item === null
      || item === undefined
      || (keyMetadataAt.some((exempt) => samePath(exempt, at)) && isAppKeyMetadata(item));
    copy[key] = kept ? redactSecrets(item, keyMetadataAt, at) : REDACTED;
  }
  return copy as T;
}
