/**
 * Listed paths written as lines of text: how the console's paths field and
 * `agw provider add --path` both read them, so a path is written the same way
 * wherever it is typed. Each line is a method and a path, then optionally
 * `$<dollars>` per request or, on a custom provider, an API style. Plain
 * functions with no Worker code, so the console and the CLI import them.
 */
import type { z } from "zod";
import { CUSTOM_PATH_STYLES, type PassthroughPathSchema } from "./admin.ts";

export type ListedPath = z.input<typeof PassthroughPathSchema>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** One listed path as a line: method, path, then a price in dollars or an API style. Its field settings are kept apart. */
export function pathLine(path: ListedPath): string {
  return [path.method, path.path, ...(path.per_request !== undefined ? [`$${path.per_request}`] : []), ...(path.style !== undefined ? [path.style] : [])].join(" ");
}

/**
 * Lines back to listed paths. Returns the paths, or the first problem with
 * its line number.
 */
export function parsePathLines(text: string, custom: boolean): { paths: ListedPath[] } | { problem: string } {
  const styles: readonly string[] = CUSTOM_PATH_STYLES;
  const paths: ListedPath[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const where = `Line ${index + 1}`;
    const [method, path, ...rest] = line.split(/\s+/u);
    const upper = method!.toUpperCase();
    if (!(METHODS as readonly string[]).includes(upper)) return { problem: `${where}: start with GET, POST, PUT, PATCH or DELETE.` };
    if (path === undefined) return { problem: `${where}: add the path after the method.` };
    const entry: ListedPath = { method: upper as ListedPath["method"], path };
    for (const token of rest) {
      if (token.startsWith("$")) {
        const price = Number(token.slice(1));
        if (token.length === 1 || !Number.isFinite(price) || price < 0) return { problem: `${where}: a price is $ and a number, such as $0.002.` };
        entry.per_request = price;
      } else if (custom && styles.includes(token)) {
        entry.style = token as ListedPath["style"];
      } else {
        return {
          problem: custom
            ? `${where}: ${token} is not a price or an API style (${styles.join(", ")}).`
            : `${where}: ${token} is not a price. Write a price as $0.002.`,
        };
      }
    }
    paths.push(entry);
  }
  return { paths };
}
