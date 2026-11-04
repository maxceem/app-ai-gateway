import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import { appPrefix, CONVERSATION_FILE_NAME } from "../../conversations/storage";

export const conversationRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(conversationRoutes);

routes.handle("listAppConversations");

/**
 * A stored file, streamed from R2 as it is: a gzipped batch, or media a record
 * names. The Worker only passes the bytes through, so a large export costs it
 * next to no CPU. The name is checked against the two shapes the store writes,
 * so nothing outside the app's own folder can be named.
 *
 * Always a download, never a page: media is whatever an app's users sent, and
 * a stored HTML file opened in a browser must not run on the gateway's origin.
 */
routes.relay("getAppConversationFile", async (c) => {
  const name = c.req.query("name") ?? "";
  if (!CONVERSATION_FILE_NAME.test(name)) {
    throw new GatewayError(
      400,
      "invalid_request",
      "name must be a file name from the listing, or a media name a record gives",
    );
  }
  const bucket = c.env.CONVERSATIONS;
  const object = bucket === undefined ? null : await bucket.get(`${appPrefix(c.req.param("app"))}${name}`);
  if (object === null) throw new GatewayError(404, "not_found", "No stored conversation file has that name");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
    },
  });
});
