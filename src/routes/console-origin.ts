import { GatewayError } from "../core/errors";
import type { Deployment } from "../policy/deployment";

/**
 * Refuses a request to a console-only endpoint reached other than from the
 * console's own pages: the URL it was sent to has to be on the console's
 * origin (404 elsewhere, the API host included, where there is no such page),
 * and the browser's `Origin` has to be that origin too (403). Runs before the
 * body is read, so a request from anywhere else learns nothing about what it
 * sent.
 *
 * A transport boundary, not authorization: who may call each endpoint is its
 * catalog policy. The CLI's browser handoff and the reveal page both sit
 * behind it, because each answers something only a person on a console page
 * should ever receive.
 */
export function assertConsoleOrigin(c: {
  req: { url: string; header(name: string): string | undefined };
  get(key: "deployment"): Deployment;
}): void {
  const consoleOrigin = c.get("deployment").identity().consoleOrigin;
  if (new URL(c.req.url).origin !== consoleOrigin)
    throw new GatewayError(404, "not_found", "Page was not found");
  if (c.req.header("origin") !== consoleOrigin)
    throw new GatewayError(403, "forbidden", "Use the first-party console page");
}
