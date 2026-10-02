import { checkApp } from "../app-check";
import { appSnippet } from "../app-snippet";
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  validateApp,
  validateAppDraft,
} from "../apps";
import type { OperationHandlerTable } from "../executor";
import { currentMonth } from "../usage-queries";

export const appHandlers = {
  listApps: ({ scope, actor, query }) => listApps(scope, actor, query.month ?? currentMonth()),
  createApp: ({ scope, actor, body }) => createApp(scope, actor, body),
  getApp: ({ scope, actor, app }) => getApp(scope, actor, app),
  validateApp: ({ scope, actor, app, body }) => validateApp(scope, actor, app, body),
  validateAppDraft: ({ scope, actor, body }) => validateAppDraft(scope, actor, body),
  checkApp: ({ scope, actor, app }) => checkApp(scope, actor, app),
  getAppSnippet: ({ scope, actor, app, query }) => appSnippet(scope, actor, app, query),
  updateApp: ({ scope, actor, app, body }) => updateApp(scope, actor, app, body),
  deleteApp: ({ scope, actor, app, query }) => deleteApp(scope, actor, app, query.confirm),
} satisfies OperationHandlerTable;
