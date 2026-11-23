/**
 * What a Cloudflare account or gateway id may be: one plain URL path segment,
 * so the address built from it is exactly the one shown, and parsing it can
 * never move it. Letters, digits, `-`, `_`, `.` and `~` (the characters a URL
 * path keeps as they are), and never `.` or `..` alone, which a URL parser
 * reads as "this folder" and "the folder above". No `/`, no `%`, no other
 * text. Shared by the gateway's checks and the console's fields.
 */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/** Why `id` cannot be a Cloudflare id, or null when it can. */
export function cloudflareIdProblem(id: string): string | null {
  if (id === "." || id === "..") return "cannot be . or ..";
  if (!PLAIN_SEGMENT.test(id)) return "may hold only letters, digits, -, _, . and ~";
  return null;
}
