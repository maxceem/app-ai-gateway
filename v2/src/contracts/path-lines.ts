/**
 * Listed paths written as lines of text: how the console's paths field and
 * `agw provider add --path` both read them, so a path is written the same way
 * wherever it is typed. Each line is a method and a path, then optionally
 * `$<dollars>` per request or, on a custom provider, an API style, or
 * `websocket` with `$<dollars>/min`: a live WebSocket session priced per
 * minute. Plain functions with no Worker code, so the console and the CLI
 * import them.
 */
import type { z } from "zod";
import { CUSTOM_PATH_STYLES, type PassthroughPathSchema } from "./admin.ts";

export type ListedPath = z.input<typeof PassthroughPathSchema>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The word that marks a custom provider's live WebSocket path, and how its price a minute ends. */
const WEBSOCKET_WORD = "websocket";
const PER_MINUTE = "/min";

/** One listed path as a line: method, path, then a price in dollars, an API style, or `websocket` and its price a minute. Its field settings are kept apart. */
export function pathLine(path: ListedPath): string {
  return [
    path.method,
    path.path,
    ...(path.per_request !== undefined ? [`$${path.per_request}`] : []),
    ...(path.style !== undefined ? [path.style] : []),
    ...(path.websocket === true ? [WEBSOCKET_WORD] : []),
    ...(path.per_minute !== undefined ? [`$${path.per_minute}${PER_MINUTE}`] : []),
  ].join(" ");
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
        const perMinute = custom && token.endsWith(PER_MINUTE);
        const text = perMinute ? token.slice(1, token.length - PER_MINUTE.length) : token.slice(1);
        const price = Number(text);
        if (text === "" || !Number.isFinite(price) || price < 0) {
          return { problem: `${where}: a price is $ and a number, such as $0.002${custom ? ", or $0.06/min for a WebSocket path" : ""}.` };
        }
        if (perMinute) entry.per_minute = price;
        else entry.per_request = price;
      } else if (custom && styles.includes(token)) {
        entry.style = token as ListedPath["style"];
      } else if (custom && token === WEBSOCKET_WORD) {
        entry.websocket = true;
      } else {
        return {
          problem: custom
            ? `${where}: ${token} is not a price or an API style (${styles.join(", ")}). A WebSocket path ends with ${WEBSOCKET_WORD} $0.06/min.`
            : `${where}: ${token} is not a price. Write a price as $0.002.`,
        };
      }
    }
    paths.push(entry);
  }
  return { paths };
}
