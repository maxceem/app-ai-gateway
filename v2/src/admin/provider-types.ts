/**
 * The provider types a connection can be added for, as the management API
 * serves them: read from the provider descriptions, so the CLI and agents
 * learn a new provider or style from the gateway, never from a release of
 * their own.
 */
import type { Context } from "hono";
import { CUSTOM_PATH_STYLES } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { CUSTOM_LABEL, CUSTOM_PROVIDER_TYPE, customOperationName } from "../providers/custom.ts";
import { BUILT_IN_PROVIDERS } from "../providers/index.ts";
import type { AdminVariables } from "./actor.ts";

type ProviderTypes = OperationResponse<"listProviderTypes">["types"];

/** Built once per isolate: the descriptions never change while it runs. */
let built: ProviderTypes | undefined;

export function providerTypes(): ProviderTypes {
  built ??= [
    ...Object.values(BUILT_IN_PROVIDERS)
      .map((description) => ({
        type: description.type,
        label: description.label,
        styles: [...new Set(description.operations.flatMap((operation) => (operation.style === undefined ? [] : [operation.style])))],
        operations: description.operations.map((operation) => operation.name),
        cloudflareGateway: description.cloudflareGateway !== undefined,
        custom: false,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    {
      type: CUSTOM_PROVIDER_TYPE,
      label: CUSTOM_LABEL,
      styles: [...CUSTOM_PATH_STYLES],
      operations: CUSTOM_PATH_STYLES.map(customOperationName),
      cloudflareGateway: false,
      custom: true,
    },
  ];
  return built;
}

export function listProviderTypes(c: Context<{ Bindings: Env; Variables: AdminVariables }>): Response {
  return c.json({ types: providerTypes() } satisfies OperationResponse<"listProviderTypes">);
}
