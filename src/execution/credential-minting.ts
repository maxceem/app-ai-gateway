/**
 * Provider paths whose answer is itself a credential.
 *
 * OpenAI's realtime API lets a client open a session directly with the
 * provider, using a short-lived key the server side mints for it:
 * `v1/realtime/client_secrets`, and the older `v1/realtime/sessions` and
 * `v1/realtime/transcription_sessions`, all answer with a live key (`ek_…`)
 * that opens sessions on the account's provider key until it expires. Proxied,
 * that answer is the app's to hand its user and nobody else's to keep, so a
 * served request on such a path is:
 *
 *   - never written to conversation storage, request or response, whatever
 *     the app's settings: a stored key would be readable later wherever the
 *     conversation is. Storage keeps only model calls, which these are not,
 *     and refuses them by name too, so that can never change by accident;
 *   - returned with `Cache-Control: no-store`, whatever the provider sent, so
 *     no cache between the gateway and the client keeps it.
 *
 * Everything else about the request — admission, limits, usage recording — is
 * unchanged.
 *
 * The rule is one decision, read by every place it applies, and it judges the
 * path that actually goes upstream rather than the entry it was allowed by.
 * It is deliberately generous in what it calls the same path: any prefix, any
 * case, repeated or trailing slashes, dot segments and percent-encoding are
 * all ignored, so a spelling the provider would still serve cannot step around
 * it. Calling a path credential-minting that is not costs only a conversation
 * not stored; the other way round costs a key.
 */

/** The realtime operations that mint a client credential, as the last path segment. */
const MINTING_OPERATIONS: ReadonlySet<string> = new Set([
  "client_secrets",
  "sessions",
  "transcription_sessions",
]);

/** A path's segments as a server would resolve them: decoded, without empty or dot segments. */
function resolvedSegments(path: string): string[] {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is left as it is; the provider refuses such a path anyway.
  }
  const segments: string[] = [];
  for (const segment of decoded.toLowerCase().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

/** True when a provider path's answer carries a credential the gateway must neither store nor let be cached. */
export function mintsCredential(providerPath: string): boolean {
  const segments = resolvedSegments(providerPath);
  const operation = segments.at(-1);
  return segments.at(-2) === "realtime" && operation !== undefined && MINTING_OPERATIONS.has(operation);
}
