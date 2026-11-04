import type { ConversationFileList } from "../../contracts/responses";
import { appPrefix } from "../../conversations/storage";
import type { OperationHandlerTable } from "../executor";

/** A batch's name within its app: `YYYY-MM-DD/HHMMSS-<batch>.jsonl.gz`. */
const BATCH_NAME = /^\d{4}-\d{2}-\d{2}\/\d{6}-[a-z0-9]{8,32}\.jsonl\.gz$/;
const LIST_PAGE = 1000;

export const conversationHandlers = {
  /**
   * One page of an app's stored batches, in key order, which is day order.
   * A page is one R2 listing, which stops at the first key past `to`. A day's
   * images sort after its batches and are passed over, so a page can hold
   * fewer batches than it lists, or none, and still have a next one.
   */
  listAppConversations: async ({ scope, params, query }): Promise<ConversationFileList> => {
    const appId = params.app;
    const bucket = scope.env.CONVERSATIONS;
    if (bucket === undefined) return { app_id: appId, files: [], next_cursor: null };
    const prefix = appPrefix(appId);
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const listing = await bucket.list({
      prefix,
      limit: LIST_PAGE,
      include: ["customMetadata"],
      ...(query.cursor
        ? { cursor: query.cursor }
        // Every key of a day sorts after the bare day, so this starts at `from`.
        : query.from ? { startAfter: `${prefix}${query.from}` } : {}),
    });
    const files: ConversationFileList["files"] = [];
    let complete = !listing.truncated;
    for (const object of listing.objects) {
      const name = object.key.slice(prefix.length);
      if (name.slice(0, 10) > to) {
        complete = true;
        break;
      }
      if (!BATCH_NAME.test(name)) continue;
      const records = Number(object.customMetadata?.records);
      files.push({
        name,
        size: object.size,
        records: Number.isInteger(records) ? records : null,
        uploaded_at: object.uploaded.toISOString(),
      });
    }
    return {
      app_id: appId,
      files,
      next_cursor: complete || !listing.truncated ? null : listing.cursor,
    };
  },
} satisfies OperationHandlerTable;
