import type { OperationHandlerTable } from "../executor";
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
} from "../providers";

export const providerHandlers = {
  listProviders: ({ scope, actor }) => listProviders(scope, actor),
  testProviderCredential: ({ scope, actor, body }) => testProvider(scope, actor, body),
  createProvider: ({ scope, actor, body }) => createProvider(scope, actor, body),
  updateProvider: ({ scope, actor, params, body }) => updateProvider(scope, actor, params.id, body),
  deleteProvider: ({ scope, actor, params }) => deleteProvider(scope, actor, params.id),
} satisfies OperationHandlerTable;
