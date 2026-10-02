import type { OperationHandlerTable } from "../executor";
import { getOperation, revealOperation } from "../operation-status";

export const operationHandlers = {
  getOperation: ({ scope, state, params }) => getOperation(scope, state, params.id),
  revealOperation: ({ scope, state, params }) => revealOperation(scope, state, params.id),
} satisfies OperationHandlerTable;
