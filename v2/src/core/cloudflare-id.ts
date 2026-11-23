/**
 * What a Cloudflare account or gateway id may be.
 *
 * A new or changed id must be one plain URL path segment
 * (`cloudflareIdProblem`), so the address built from it is exactly the one
 * shown: letters, digits, `-`, `_`, `.` and `~`, never `.` or `..` alone. No
 * `/`, no `%`, no other text.
 *
 * An id stored before that rule may hold other text, such as a space. It is
 * encoded into its own path segment wherever it becomes an address, so it
 * stays where it was, and it keeps working (`cloudflareIdUsable`). Only `.`
 * and `..` never do: a URL parser reads them as "this folder" and "the folder
 * above" even when encoded.
 */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/** Why `id` cannot be a new Cloudflare id, or null when it can. */
export function cloudflareIdProblem(id: string): string | null {
  if (id === "." || id === "..") return "cannot be . or ..";
  if (!PLAIN_SEGMENT.test(id)) return "may hold only letters, digits, -, _, . and ~";
  return null;
}

/** Whether `id` can stand in an address at all, encoded as one segment: what a stored id needs to keep working. */
export function cloudflareIdUsable(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/\p{Cs}/u.test(id);
}
