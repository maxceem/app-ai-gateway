import type { Bootstrap } from "./contract";

/**
 * The bootstrap as a header value. Header values must be Latin-1, and a user
 * id or app version may hold any character, so the JSON is percent-encoded.
 */
export function bootstrapHeader(bootstrap: Bootstrap): string {
  return encodeURIComponent(JSON.stringify(bootstrap));
}

/** The bootstrap a header carries; throws on a value {@link bootstrapHeader} did not write. */
export function readBootstrapHeader(value: string): unknown {
  return JSON.parse(decodeURIComponent(value));
}
