/**
 * Where a connection's requests, and so its provider key, can go: one place
 * that both the gateway's routing (`./connections.ts`, `./route.ts`) and the
 * console's key fields read, so what the console tells a person about a key
 * can never differ from where the gateway sends it.
 *
 * Plain functions of a connection's settings and its provider description,
 * with no Worker code, so the console can import them.
 */
import { checkOperatorBaseUrl } from "../core/origin-guard.ts";
import type { ProviderDescription } from "./operation.ts";
import { normalizePath, type PathRefusal } from "./path.ts";

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

/**
 * Whether text is well-formed: no half of a surrogate pair stands alone. Text
 * that is not cannot be put in a URL (`encodeURIComponent` throws on it), so
 * such a Cloudflare account or gateway id could never have reached Cloudflare.
 */
export function wellFormedText(text: string): boolean {
  return !/\p{Cs}/u.test(text);
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
  if (setting.cloudflareGateway !== null) {
    const { accountId, gatewayId } = setting.cloudflareGateway;
    // Ids that cannot be put in a URL lead nowhere.
    if (!wellFormedText(accountId) || !wellFormedText(gatewayId)) return [];
    return [cloudflareGatewayOrigin(setting.cloudflareGateway)];
  }
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

/** Why a base URL's path could reach another path at the provider than the one judged, in words. */
const BASE_PATH_PROBLEMS: Readonly<Record<PathRefusal, string>> = {
  bad_encoding: "has broken percent-encoding",
  dot_segment: "has a . or .. segment",
  encoded_separator: "has an encoded / or \\",
  control_character: "has a control character",
};

/**
 * A base URL as the gateway saves it, or why it is refused: the origin guard,
 * then its path through the same normalization request paths get
 * (`normalizePath`). Listings are judged on its segments, so an encoded
 * slash, a backslash, a dot segment, broken encoding or an empty segment,
 * which the provider could read as other segments, is refused. A stored base
 * URL sent back unchanged (`unchanged`) is not judged again. The console runs
 * a typed base URL through this too, so the hosts it names for a key are the
 * ones the saved URL routes to.
 */
export function normalizedBaseUrl(raw: string, unchanged: string | null = null): { readonly ok: true; readonly baseUrl: string } | { readonly ok: false; readonly message: string } {
  const checked = checkOperatorBaseUrl(raw);
  if (!checked.ok) return { ok: false, message: checked.message };
  if (checked.baseUrl === unchanged) return checked;
  const pathname = new URL(checked.baseUrl).pathname;
  const normalized = normalizePath(pathname);
  if (!normalized.ok) return { ok: false, message: `its path ${BASE_PATH_PROBLEMS[normalized.reason]}` };
  if (pathname.length > 1 && pathname.slice(1, -1).split("/").includes("")) return { ok: false, message: "its path has an empty segment (//)" };
  return checked;
}
