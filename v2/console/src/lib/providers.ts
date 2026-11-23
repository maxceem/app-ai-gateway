import { CUSTOM_PATH_STYLES, CUSTOM_PROVIDER_TYPE } from "@contracts/admin";
import { BUILT_IN_PROVIDERS } from "@providers/index";
import type { SuggestedPath } from "@providers/operation";

/** What people call each built-in provider, and a custom one. A type this build does not know shows as itself. */
export function providerLabel(type: string): string {
  if (type === CUSTOM_PROVIDER_TYPE) return "Custom provider";
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type]!.label : type;
}

/** The host a built-in provider's requests go to without a base URL, such as api.openai.com. */
export function providerHost(type: string): string {
  if (!Object.hasOwn(BUILT_IN_PROVIDERS, type)) return type;
  const main = BUILT_IN_PROVIDERS[type]!.hosts.main;
  try {
    return new URL(main).host;
  } catch {
    return main;
  }
}

/** Whether a provider type can be reached through Cloudflare AI Gateway (D13). */
export function cloudflareCapable(type: string): boolean {
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) && BUILT_IN_PROVIDERS[type]!.cloudflareGateway !== undefined;
}

/** Every provider type a connection can be added for, by label, then a custom provider. */
export const PROVIDER_TYPES: { type: string; label: string }[] = [
  ...Object.keys(BUILT_IN_PROVIDERS)
    .map((type) => ({ type, label: providerLabel(type) }))
    .sort((a, b) => a.label.localeCompare(b.label)),
  { type: CUSTOM_PROVIDER_TYPE, label: providerLabel(CUSTOM_PROVIDER_TYPE) },
];

/** A provider's suggested path for a listed method and path (plan section 4.5): its safe defaults, and whether it mints a live-session secret. */
export function suggestedPath(type: string, method: string, path: string): SuggestedPath | null {
  if (!Object.hasOwn(BUILT_IN_PROVIDERS, type)) return null;
  const bare = path.replace(/^\/+/u, "");
  return BUILT_IN_PROVIDERS[type]!.suggestedPaths?.find((entry) => entry.method === method && entry.path === bare) ?? null;
}

/** The API styles a custom provider's path may speak. */
export const CUSTOM_STYLES: readonly string[] = CUSTOM_PATH_STYLES;

export interface OperationChoice {
  name: string;
  /** A live session, which the relay serves in a later release. */
  session: boolean;
}

/** What an app may enable on a connection: its type's operations, and what its listed paths add. */
interface ConnectionShape {
  readonly type: string;
  readonly passthrough?: readonly { readonly style?: string | undefined }[] | undefined;
}

/**
 * The operations an app may enable on a connection, in order: its type's own,
 * a custom provider's operation for each API style it lists, then
 * `passthrough` when it lists paths to pass through.
 */
export function operationsOf(connection: ConnectionShape): OperationChoice[] {
  const { type } = connection;
  const description = Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type] : undefined;
  const declared = (description?.operations ?? []).map((operation) => ({
    name: operation.name,
    session: operation.session !== undefined,
  }));
  const listed = connection.passthrough ?? [];
  const styles = type === CUSTOM_PROVIDER_TYPE ? listed.flatMap((path) => (path.style === undefined ? [] : [{ name: `${CUSTOM_PROVIDER_TYPE}.${path.style}`, session: false }])) : [];
  const passthrough = listed.some((path) => path.style === undefined) ? [{ name: "passthrough", session: false }] : [];
  return [...declared, ...styles, ...passthrough];
}
