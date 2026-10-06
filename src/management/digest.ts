const encoder = new TextEncoder();

/** The SHA-256 of a string, as 64 lowercase hex characters. */
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Whether `raw` is the secret whose {@link digest} is `expected`, compared in
 * constant time. Anything but a string, or no expected digest, never matches.
 */
export async function proofMatches(
  raw: unknown,
  expected: string | null,
): Promise<boolean> {
  if (typeof raw !== "string" || !expected) return false;
  const hash = await digest(raw);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(hash));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected));
}
