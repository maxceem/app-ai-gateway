import type { OperationHandlerTable } from "../executor";
import { getAppUser, listAppUsers, setAppUserBlocked } from "../users";

export const userHandlers = {
  listAppUsers: ({ scope, actor, app, query }) => listAppUsers(scope, actor, app, query),
  getAppUser: ({ scope, actor, app, params, query }) =>
    getAppUser(scope, actor, app, params.user, query),
  blockAppUser: ({ scope, actor, app, params }) =>
    setAppUserBlocked(scope, actor, app, params.user, true),
  unblockAppUser: ({ scope, actor, app, params }) =>
    setAppUserBlocked(scope, actor, app, params.user, false),
} satisfies OperationHandlerTable;
