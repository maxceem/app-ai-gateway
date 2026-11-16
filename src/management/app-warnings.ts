/**
 * An application's warnings: what its owner should know about its settings
 * or how it is used, or behaviour that will stop on a stated date. Worked out
 * on every read and save, never stored or written, and never a reason to
 * refuse a save: the application keeps working with them. Each one is
 * `{ code, message, until?, docs_url? }`.
 *
 * The API, the console, the CLI and MCP show whatever this returns.
 */

import type { AppWarning } from "../contracts/responses";
import type { AppConfig } from "../contracts/schemas";
import { DIRECT_ACCESS_GUIDE_URL, hasGatewayRealtime, isDirectAccessPath, providerPolicyFor } from "../shared/app-config";
import { providerDescriptor, type ProviderType } from "../shared/providers";

/** One of the account's provider instances, as far as warnings need it. */
interface ProviderRef {
  slug: string;
  type: ProviderType;
}

/**
 * The warnings for an application's configuration, judged against the
 * account's providers. A slug with no provider row behind it has none.
 */
export function appWarnings(config: AppConfig, providers: Iterable<ProviderRef>): AppWarning[] {
  const warnings: AppWarning[] = [];
  for (const provider of providers) {
    const policy = providerPolicyFor(config.routing, provider.slug);
    if (!policy) continue;
    const paths = [...new Set(
      policy.allowed_paths
        .map((entry) => (typeof entry === "string" ? entry : entry.path))
        .filter((path) => isDirectAccessPath(provider.type, path)),
    )];
    if (paths.length > 0) warnings.push(directAccessWarning(provider, paths));
  }
  return warnings;
}

function directAccessWarning(provider: ProviderRef, paths: readonly string[]): AppWarning {
  const label = providerDescriptor(provider.type).label;
  const one = paths.length === 1;
  const risk = `You configured ${listed(paths.map((path) => `\`${path}\``))} for provider "${provider.slug}". ${
    one ? "This endpoint lets" : "These endpoints let"
  } your app talk to ${label} directly, so the gateway can't count, limit or record those conversations.`;
  // Suggested only where the gateway runs this provider's realtime conversations.
  if (!hasGatewayRealtime(provider.type)) return { code: "realtime_client_secrets", message: risk };
  return {
    code: "realtime_client_secrets",
    message: `${risk} Use realtime through the gateway instead, then remove ${one ? "this endpoint" : "these endpoints"}.`,
    docs_url: DIRECT_ACCESS_GUIDE_URL,
  };
}

function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
