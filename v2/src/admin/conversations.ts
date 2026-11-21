/**
 * An app's stored conversations, through the management API (v1's
 * `listAppConversations` and `getAppConversationFile`, ported).
 *
 * The listing is one R2 listing per page. A download is streamed from R2 as
 * it is: a gzipped batch, or media a record names. The Worker only passes the
 * bytes through, so a large export costs it next to no CPU.
 */
import type { Context } from "hono";
import { ConversationFileQuerySchema, ConversationListQuerySchema } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { appPrefix, CONVERSATION_BATCH_NAME, CONVERSATION_FILE_NAME, conversationsBucket } from "../conversations/storage.ts";
import { requireAdminRole, type AdminVariables } from "./actor.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

const LIST_PAGE = 1000;

/** The app, if it is the caller's account's: stored conversations are reached through it only. */
async function ownApp(c: AdminContext): Promise<{ accountId: string; appId: string }> {
  const appId = c.req.param("app")!;
  // The app is looked up within the caller's account first, as v1 did: a missing
  // app, or another account's, is 404 to anyone.
  const found = await c.env.DB.prepare("SELECT 1 AS found FROM app WHERE id = ? AND account_id = ?").bind(appId, c.get("actor").accountId).first();
  if (found === null) throw new GatewayError(404, "app_not_found", "App is not registered");
  // v1 kept stored prompts and media to owners and admins; a member reads neither.
  requireAdminRole(c.get("actor"));
  return { accountId: c.get("actor").accountId, appId };
}

/**
 * One page of an app's stored batches, in key order, which is day order. A
 * page is one R2 listing, which stops at the first key past `to`. A day's
 * media sorts after its batches and is passed over, so a page can hold fewer
 * batches than it lists, or none, and still have a next one.
 */
export async function listAppConversations(c: AdminContext): Promise<Response> {
  const { accountId, appId } = await ownApp(c);
  const parsed = ConversationListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new GatewayError(400, "invalid_request", parsed.error.issues[0]?.message ?? "The query is invalid");
  const query = parsed.data;
  const bucket = conversationsBucket(c.env);
  if (bucket === null) return c.json({ app_id: appId, files: [], next_cursor: null } satisfies OperationResponse<"listAppConversations">);
  // The account's own folder for the app: an app id another account used before never reaches it.
  const prefix = appPrefix(accountId, appId);
  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const listing = await bucket.list({
    prefix,
    limit: LIST_PAGE,
    include: ["customMetadata"],
    ...(query.cursor !== undefined
      ? { cursor: query.cursor }
      : // Every key of a day sorts after the bare day, so this starts at `from`.
        query.from !== undefined
        ? { startAfter: `${prefix}${query.from}` }
        : {}),
  });
  const files: OperationResponse<"listAppConversations">["files"] = [];
  let complete = !listing.truncated;
  for (const object of listing.objects) {
    const name = object.key.slice(prefix.length);
    if (name.slice(0, 10) > to) {
      complete = true;
      break;
    }
    if (!CONVERSATION_BATCH_NAME.test(name)) continue;
    const records = Number(object.customMetadata?.records);
    files.push({ name, size: object.size, records: Number.isInteger(records) ? records : null, uploaded_at: object.uploaded.toISOString() });
  }
  return c.json({
    app_id: appId,
    files,
    next_cursor: complete || !listing.truncated ? null : listing.cursor,
  } satisfies OperationResponse<"listAppConversations">);
}

/**
 * A stored file, streamed from R2 as it is. The name is checked against the
 * two shapes the store writes, so nothing outside the app's own folder can be
 * named. Always a download, never a page: media is whatever an app's users
 * sent, and a stored HTML file opened in a browser must not run on the
 * gateway's origin.
 */
export async function getAppConversationFile(c: AdminContext): Promise<Response> {
  const { accountId, appId } = await ownApp(c);
  const parsed = ConversationFileQuerySchema.safeParse(c.req.query());
  const name = parsed.success ? parsed.data.name : "";
  if (!CONVERSATION_FILE_NAME.test(name)) {
    throw new GatewayError(400, "invalid_request", "name must be a file name from the listing, or a media name a record gives");
  }
  const bucket = conversationsBucket(c.env);
  const object = bucket === null ? null : await bucket.get(`${appPrefix(accountId, appId)}${name}`);
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
}
