/**
 * The one table of names a credential goes by (v1's, ported), for both
 * directions of the MCP tools: an argument with one of these names is refused
 * before anything reads it, and a result field with one of these names is
 * shown as {@link REDACTED}.
 *
 * Names are compared whole after lower-casing and dropping `_` and `-`, so
 * `Token`, `api_key`, `apiKey` and `API-KEY` all match, and `secretHint` or
 * `max_tokens`, which are not credentials, never do.
 *
 * One exemption, v1's: the metadata of an app key a tool created, at the
 * exact path where that tool answers it (`keyMetadataAt`).
 */
import { AppKeyMetadataSchema } from "../contracts/handoffs.ts";

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

/** The dotted path of the first field anywhere in `value` named like a credential, or null. */
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
 * which a create answers in place of the key. Read off the response schema,
 * so the exemption cannot outgrow it.
 */
const APP_KEY_METADATA_FIELDS: ReadonlySet<string> = new Set(Object.keys(AppKeyMetadataSchema.shape));

/** A path into a result, field by field, such as `["result", "api_key"]`. */
export type ResultPath = readonly string[];

/** Whether `value` has the shape of an app key's metadata, every field a plain value the schema names. */
function isAppKeyMetadata(value: unknown): boolean {
  return isObject(value)
    && Object.entries(value).every(([field, item]) => APP_KEY_METADATA_FIELDS.has(field) && (item === null || typeof item !== "object"));
}

function samePath(left: ResultPath, right: ResultPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * A copy of a result in which every field named like a credential is
 * {@link REDACTED}, whatever it holds, at any depth. A field holding nothing
 * (`null`) stays as it is. `hidden` collects the dotted path of each one.
 *
 * The one exemption is positional: `keyMetadataAt` names the exact paths at
 * which a tool answers the metadata of an app key it created, and an object
 * there is kept only when it has the metadata's shape. Anywhere else an
 * `api_key` is redacted like any other credential-named field.
 *
 * Applied to whatever a tool answers: an app document stored through the API
 * may carry provider-native parameters of any name.
 */
export function redactSecrets<T>(
  value: T,
  keyMetadataAt: readonly ResultPath[] = [],
  path: ResultPath = [],
  hidden: string[] = [],
): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecrets(item, keyMetadataAt, [...path, String(index)], hidden)) as T;
  }
  if (!isObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const at = [...path, key];
    const kept = !isSecretFieldName(key)
      || item === null
      || item === undefined
      || (keyMetadataAt.some((exempt) => samePath(exempt, at)) && isAppKeyMetadata(item));
    if (!kept) hidden.push(at.join("."));
    copy[key] = kept ? redactSecrets(item, keyMetadataAt, at, hidden) : REDACTED;
  }
  return copy as T;
}
