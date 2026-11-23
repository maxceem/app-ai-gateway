/**
 * The two route middlewares that rewrite an answer's headers after the
 * handler: `serverTiming` (proxy, presets, passthrough and job polls) and
 * `pollNoStore` (job polls). Hono copies an old answer's headers onto a new
 * one it is given, so each clears the old answer first; otherwise the
 * provider's own header would come back over the gateway's.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { pollNoStore } from "../src/jobs/poll.ts";
import { serverTiming } from "../src/proxy/timing.ts";

/** Headers that refuse every change, as those of an answer passed on as it came. */
class LockedHeaders extends Headers {
  override set(): void {
    throw new TypeError("immutable");
  }
  override delete(): void {
    throw new TypeError("immutable");
  }
}

/** An answer whose headers cannot change, carrying the provider's own `server-timing` and cache header. */
function lockedAnswer(): Response {
  const response = new Response("{}", { status: 200 });
  Object.defineProperty(response, "headers", {
    value: new LockedHeaders({ "server-timing": "upstream;dur=9", "cache-control": "public, max-age=60", "content-type": "application/json" }),
  });
  return response;
}

describe("headers rewritten after the handler", () => {
  it("server-timing replaces the provider's own, even on an answer whose headers cannot change", async () => {
    const app = new Hono();
    app.get("/served", serverTiming, () => lockedAnswer());
    const response = await app.request("/served");
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).not.toContain("upstream");
    expect(timing).toMatch(/^auth;dur=\d+\.\d$/u);
    expect(await response.text()).toBe("{}");
  });

  it("a poll answer is never cacheable, whatever cache header the provider sent", async () => {
    const app = new Hono();
    app.get("/poll", pollNoStore, () => new Response("{}", { headers: { "cache-control": "public, max-age=60", "cdn-cache-control": "max-age=60" } }));
    const response = await app.request("/poll");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBeNull();
  });
});
