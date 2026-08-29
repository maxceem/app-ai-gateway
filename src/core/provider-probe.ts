import { GatewayError } from "./errors";
import { gatewayProbe } from "./gateways";
import { log } from "./log";
import { PROVIDER_REGISTRY, providerAuthValue } from "./providers";
import type { ProviderType } from "./types";

/**
 * The cheapest authenticated call each provider offers. Perplexity has no
 * unmetered authenticated endpoint, so its credentials are accepted unvalidated
 * and flagged in the console.
 */
const PROBE_PATHS: Partial<Record<ProviderType, string>> = {
  openai: "v1/models",
  xai: "v1/models",
  gemini: "v1beta/models",
  anthropic: "v1/models",
};

const PROBE_TIMEOUT_MS = 4_000;

/** Why a probe proved nothing. Absent when the credential was confirmed. */
export type ProbeReason =
  /** This provider offers no cheap authenticated call to probe with. */
  | "no_probe"
  /** The request never completed: DNS, connection, or the timeout above. */
  | "unreachable"
  /** Something answered, but not with the success that would prove anything. */
  | "unexpected_status";

export interface ProbeResult {
  /** `false` means "not proven good", never "proven bad" — see below. */
  validated: boolean;
  reason?: ProbeReason;
  /** The status behind an `unexpected_status`, which is what names the fault. */
  status?: number;
}

/**
 * A probe has exactly two outcomes worth acting on: the upstream said the
 * credential is wrong (reject the write), or it did not (accept it). A provider
 * outage, a network blip, or a provider without a probe must never block an
 * operator from saving a key they know is correct.
 */
async function runProbe(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    log("warn", "provider_probe_unreachable", {
      probe: label,
      error: error instanceof Error ? error.message : String(error),
    });
    return { validated: false, reason: "unreachable" };
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    // Only the upstream status travels back; the credential never does.
    throw new GatewayError(
      400,
      "provider_key_invalid",
      `The credential was rejected by the provider (HTTP ${response.status})`,
    );
  }
  if (!response.ok) {
    // A gateway that holds no key for this provider answers here, so the status
    // is the only thing that tells the operator what to go and fix.
    log("warn", "provider_probe_inconclusive", { probe: label, status: response.status });
    return { validated: false, reason: "unexpected_status", status: response.status };
  }
  return { validated: true };
}

export async function probeProviderKey(
  type: ProviderType,
  secret: string,
): Promise<ProbeResult> {
  const path = PROBE_PATHS[type];
  if (!path) return { validated: false, reason: "no_probe" };
  const spec = PROVIDER_REGISTRY[type];
  const headers: Record<string, string> = {
    [spec.auth.header]: providerAuthValue(type, secret),
  };
  // Anthropic refuses any request without a version header, probe included.
  if (type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(type, `${spec.directBaseUrl}${path}`, headers);
}

/**
 * Probes one provider through a reusable Cloudflare AI Gateway connection. The
 * URL and the gateway auth header come from the adapter that serves live
 * traffic, so a probe can never test a route production does not use.
 */
export async function probeProviderGateway(input: {
  type: ProviderType;
  accountId: string;
  gatewayId: string;
  token: string;
}): Promise<ProbeResult> {
  const probePath = PROBE_PATHS[input.type];
  if (!probePath) return { validated: false, reason: "no_probe" };
  const request = gatewayProbe({
    gateway: {
      type: "cf_aig",
      config: { accountId: input.accountId, gatewayId: input.gatewayId },
    },
    secret: input.token,
    provider: input.type,
    path: probePath,
  });
  // A provider type this gateway does not serve has nothing to prove here.
  if (!request) return { validated: false, reason: "no_probe" };
  const headers: Record<string, string> = { ...request.headers };
  if (input.type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(`${input.type}_via_cf_aig`, request.url, headers);
}

/**
 * One call proves the account id, the gateway id, and the token together, which
 * is exactly the set of mistakes the preset form can produce.
 */
export async function probeCfAigPreset(input: {
  accountId: string;
  gatewayId: string;
  token: string;
}): Promise<ProbeResult> {
  return probeProviderGateway({
    type: "openai",
    accountId: input.accountId,
    gatewayId: input.gatewayId,
    token: input.token,
  });
}
