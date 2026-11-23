/**
 * Where a connection's requests, and so its provider key, can go: one place
 * that both the gateway's routing (`./connections.ts`, `./route.ts`) and the
 * console's key fields read, so what the console tells a person about a key
 * can never differ from where the gateway sends it.
 *
 * Plain functions of a connection's settings and its provider description,
 * with no Worker code, so the console can import them.
 */
import type { ProviderDescription } from "./operation.ts";

/** Cloudflare AI Gateway's own origin. */
export const CLOUDFLARE_AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/";

/**
 * A test deployment's stand-in for Cloudflare AI Gateway (the mock), set at
 * build time by `define` in its own gitignored Wrangler config, and in no other
 * build. Nothing at run time can set it: a Worker variable could otherwise
 * send Cloudflare tokens and provider keys to any origin.
 */
declare const __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__: string | undefined;

/** Where requests through Cloudflare AI Gateway go: Cloudflare, unless this is a test deployment's build. */
export function cloudflareOrigin(): string {
  const moved = typeof __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__ === "string" ? __TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__ : "";
  if (moved === "") return CLOUDFLARE_AI_GATEWAY_ORIGIN;
  return moved.endsWith("/") ? moved : `${moved}/`;
}

/** The origin and path every request through one Cloudflare AI Gateway goes under. */
export function cloudflareGatewayOrigin(gateway: { readonly accountId: string; readonly gatewayId: string }): string {
  return `${cloudflareOrigin()}v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/`;
}

/** A connection's settings that decide where its requests go. */
export interface RouteSetting {
  readonly baseUrl: string | null;
  readonly cloudflareGateway: { readonly accountId: string; readonly gatewayId: string } | null;
}

/** Whether `baseUrl` is exactly one of the provider's declared hosts, as its default routing would address it. */
function isDeclaredHost(description: ProviderDescription, baseUrl: string): boolean {
  let href: string;
  try {
    href = new URL(baseUrl).href;
  } catch {
    return false;
  }
  return Object.values(description.hosts).some((declared) => new URL(`https://${declared}/`).href === href);
}

/**
 * The origin a direct request (not through Cloudflare) goes to for one of the
 * provider's hosts, or null when the description names no such host. A base
 * URL replaces every host, unless it is exactly one of the provider's own,
 * which keeps the provider's routing; passthrough always uses the base URL.
 */
export function directOrigin(setting: Pick<RouteSetting, "baseUrl">, description: ProviderDescription, hostKey: string, passthrough = false): string | null {
  const host = description.hosts[hostKey];
  if (host === undefined) return null;
  if (setting.baseUrl !== null && (passthrough || !isDeclaredHost(description, setting.baseUrl))) {
    return hostKey === "main" ? setting.baseUrl : `${setting.baseUrl}${hostKey}/`;
  }
  return `https://${host}/`;
}

/**
 * Every origin the gateway can send a connection's provider key to, for its
 * settings: its Cloudflare AI Gateway, or else each of the provider's hosts as
 * its base URL routes them, passthrough included. `description` is null for a
 * custom provider, whose base URL is its one destination.
 */
export function keyDestinations(description: ProviderDescription | null, setting: RouteSetting): string[] {
  if (setting.cloudflareGateway !== null) return [cloudflareGatewayOrigin(setting.cloudflareGateway)];
  if (description === null) return setting.baseUrl === null ? [] : [setting.baseUrl];
  const origins = new Set<string>();
  for (const hostKey of Object.keys(description.hosts)) {
    for (const passthrough of [false, true]) {
      const origin = directOrigin(setting, description, hostKey, passthrough);
      if (origin !== null) origins.add(origin);
    }
  }
  return [...origins];
}

/** The destinations as a person reads them: each without its scheme or trailing slash. */
export function destinationText(origins: readonly string[]): string {
  return origins.map((origin) => origin.replace(/^https?:\/\//u, "").replace(/\/$/u, "")).join(", ");
}
