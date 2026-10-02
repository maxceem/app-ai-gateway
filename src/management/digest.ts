const encoder = new TextEncoder();

/** The SHA-256 of a string, as 64 lowercase hex characters. */
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
