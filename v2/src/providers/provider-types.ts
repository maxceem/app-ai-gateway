/**
 * The provider types a connection can be added for, read from the provider
 * descriptions: built-in ones by label, then the custom type. The management
 * API serves them (`listProviderTypes`), and the console lists them from the
 * same function, so the two never differ.
 */
import { CUSTOM_PATH_STYLES } from "../contracts/admin.ts";
import { CUSTOM_LABEL, CUSTOM_PROVIDER_TYPE, customOperationName } from "./custom.ts";
import { BUILT_IN_PROVIDERS } from "./index.ts";

export interface ProviderTypeEntry {
  readonly type: string;
  readonly label: string;
  /** The API styles of its operations, in the order it declares them. */
  readonly styles: readonly string[];
  /** Its operations' names, in the order it declares them; a custom provider's, one per style. */
  readonly operations: readonly string[];
  readonly cloudflareGateway: boolean;
  readonly custom: boolean;
}

/** Built once: the descriptions never change while code runs. */
let built: readonly ProviderTypeEntry[] | undefined;

export function providerTypes(): readonly ProviderTypeEntry[] {
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
