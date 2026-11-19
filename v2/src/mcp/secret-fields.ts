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
 * v1 kept one exemption, for the metadata of an app key a tool had just
 * created. No v2 tool creates a key, so there is none here.
 */

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
 * A copy of a result in which every field named like a credential is
 * {@link REDACTED}, whatever it holds, at any depth. A field holding nothing
 * (`null`) stays as it is. `hidden` collects the dotted path of each one.
 *
 * Applied to whatever a tool answers: an app document stored through the API
 * may carry provider-native parameters of any name.
 */
export function redactSecrets<T>(value: T, path: readonly string[] = [], hidden: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecrets(item, [...path, String(index)], hidden)) as T;
  }
  if (!isObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const at = [...path, key];
    const kept = !isSecretFieldName(key) || item === null || item === undefined;
    if (!kept) hidden.push(at.join("."));
    copy[key] = kept ? redactSecrets(item, at, hidden) : REDACTED;
  }
  return copy as T;
}
