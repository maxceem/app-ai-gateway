import { GatewayError } from "./errors";
import { log } from "./log";
import { CF_AI_GATEWAY_BASE_URL } from "./proxyrules";
import { PROVIDER_REGISTRY } from "./providers";
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

export interface ProbeResult {
  /** `false` means "not proven good", never "proven bad" — see below. */
  validated: boolean;
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
    return { validated: false };
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
    log("warn", "provider_probe_inconclusive", { probe: label, status: response.status });
    return { validated: false };
  }
  return { validated: true };
}

export async function probeProviderKey(
  type: ProviderType,
  secret: string,
): Promise<ProbeResult> {
  const path = PROBE_PATHS[type];
  if (!path) return { validated: false };
  const spec = PROVIDER_REGISTRY[type];
  const headers: Record<string, string> = {
    [spec.auth.header]: `${"scheme" in spec.auth ? spec.auth.scheme : ""}${secret}`,
  };
  // Anthropic refuses any request without a version header, probe included.
  if (type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(type, `${spec.directBaseUrl}${path}`, headers);
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
  const url = [
    CF_AI_GATEWAY_BASE_URL,
    encodeURIComponent(input.accountId),
    encodeURIComponent(input.gatewayId),
    "openai",
    "models",
  ].join("/");
  return runProbe("cf_aig", url, { "cf-aig-authorization": `Bearer ${input.token}` });
}
