import type { OperationHandlerTable } from "../executor";
import { createAppKey, listAppKeys, revokeAppKey } from "../keys";

export const keyHandlers = {
  createAppKey: ({ scope, actor, app, body }) => createAppKey(scope, actor, app, body),
  listAppKeys: ({ scope, actor, app }) => listAppKeys(scope, actor, app),
  revokeAppKey: ({ scope, actor, app, params }) => revokeAppKey(scope, actor, app, params.key),
} satisfies OperationHandlerTable;
