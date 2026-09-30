import { getAppAuthEventSummary, listAppAuthEvents } from "../auth-events";
import type { OperationHandlerTable } from "../executor";
import { listAppRejectionEvents } from "../rejection-events";

export const authEventHandlers = {
  getAppAuthEventSummary: ({ scope, actor, app, query }) =>
    getAppAuthEventSummary(scope, actor, app, query),
  listAppAuthEvents: ({ scope, actor, app, query }) => listAppAuthEvents(scope, actor, app, query),
  listAppRejectionEvents: ({ scope, actor, app, query }) =>
    listAppRejectionEvents(scope, actor, app, query),
} satisfies OperationHandlerTable;
