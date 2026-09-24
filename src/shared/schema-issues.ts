import type { z } from "zod";

/**
 * The one way a schema rejection is worded, wherever one is reported: a
 * request body or query string on the server, an application configuration in
 * the console or the CLI.
 *
 * The first issue only: a request is repaired one field at a time, and a list
 * of every consequence of a single missing key is noise in an error message.
 * The path comes first because it is what the reader has to find, and `body`
 * stands for the root. A message that already begins with the name of what it
 * is about is left as written: a query parameter's own `limit must be…`, or a
 * schema's own sentence for a key it refuses, such as the one an application
 * write answers a client still sending `id` with.
 */
export function schemaIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "Invalid request";
  const path = issue.path.join(".");
  const named = path !== "" ? [path] : issue.code === "unrecognized_keys" ? issue.keys : [];
  if (named.some((name) => issue.message.startsWith(`${name} `))) return issue.message;
  return `${path || "body"}: ${issue.message}`;
}
