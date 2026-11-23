/**
 * The operations an app may allow on one provider connection, in order: its
 * type's own declared operations, a custom provider's operation for each API
 * style its paths name, then `passthrough` when it lists plain paths. The one
 * place both the console's providers tab and `agw app add --providers` read
 * them from. Plain functions, so the console and the CLI import them.
 */
import { CUSTOM_PROVIDER_TYPE, customOperationName, isCustomStyle } from "../providers/custom.ts";

/** The operation an app allows to reach a connection's listed plain paths. */
export const PASSTHROUGH_OPERATION = "passthrough";

/**
 * `declared` is the type's own operation names, from its provider description
 * or the gateway's provider types; a custom provider has none.
 */
export function connectionOperations(
  connection: { readonly type: string; readonly passthrough?: readonly { readonly style?: string | undefined }[] | undefined },
  declared: readonly string[],
): string[] {
  const listed = connection.passthrough ?? [];
  const styles =
    connection.type === CUSTOM_PROVIDER_TYPE
      ? listed.flatMap((path) => (path.style !== undefined && isCustomStyle(path.style) ? [customOperationName(path.style)] : []))
      : [];
  const passthrough = listed.some((path) => path.style === undefined) ? [PASSTHROUGH_OPERATION] : [];
  return [...(connection.type === CUSTOM_PROVIDER_TYPE ? [] : declared), ...styles, ...passthrough];
}
