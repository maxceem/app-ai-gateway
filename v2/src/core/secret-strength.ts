/**
 * Whether a deployment secret is long enough to derive a signing key from: a
 * string of at least 32 bytes, as the README asks of `JWT_SECRET` and
 * `BETTER_AUTH_SECRET`. An empty or missing secret would otherwise give HKDF
 * empty key material and a key anyone can compute.
 */
export const MIN_SECRET_BYTES = 32;

const encoder = new TextEncoder();

export function secretStrongEnough(secret: string | undefined): secret is string {
  return typeof secret === "string" && encoder.encode(secret).byteLength >= MIN_SECRET_BYTES;
}
