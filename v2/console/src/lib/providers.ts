import { BUILT_IN_PROVIDERS } from "@providers/index";

/** What people call each built-in provider. A type this build does not know shows as itself. */
export function providerLabel(type: string): string {
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type]!.label : type;
}

/** Whether a provider type can be reached through Cloudflare AI Gateway (D13). */
export function cloudflareCapable(type: string): boolean {
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) && BUILT_IN_PROVIDERS[type]!.cloudflareGateway !== undefined;
}

/** Every provider type a connection can be added for, by label. */
export const PROVIDER_TYPES: { type: string; label: string }[] = Object.keys(BUILT_IN_PROVIDERS)
  .map((type) => ({ type, label: providerLabel(type) }))
  .sort((a, b) => a.label.localeCompare(b.label));

export interface OperationChoice {
  name: string;
  /** A live session, which the relay serves in a later release. */
  session: boolean;
}

/** The operations a provider type declares, in its own order. */
export function operationsOf(type: string): OperationChoice[] {
  const description = Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type] : undefined;
  return (description?.operations ?? []).map((operation) => ({
    name: operation.name,
    session: operation.session !== undefined,
  }));
}
