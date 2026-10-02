import type { OperationHandlerTable } from "../executor";
import {
  createProviderGateway,
  deleteProviderGateway,
  listProviderGateways,
  rotateProviderGateway,
  testProviderGateway,
  updateProviderGateway,
} from "../provider-gateways";

export const providerGatewayHandlers = {
  testProviderGateway: ({ scope, actor, body }) => testProviderGateway(scope, actor, body),
  listProviderGateways: ({ scope, actor }) => listProviderGateways(scope, actor),
  createProviderGateway: ({ scope, actor, body }) => createProviderGateway(scope, actor, body),
  updateProviderGateway: ({ scope, actor, params, body }) =>
    updateProviderGateway(scope, actor, params.id, body),
  rotateProviderGateway: ({ scope, actor, params, body }) =>
    rotateProviderGateway(scope, actor, params.id, body),
  deleteProviderGateway: ({ scope, actor, params }) => deleteProviderGateway(scope, actor, params.id),
} satisfies OperationHandlerTable;
