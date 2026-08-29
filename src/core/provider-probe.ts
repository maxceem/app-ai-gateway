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

/** Why a probe did not confirm the credential. Absent when it did. */
export type ProbeReason =
  /** This provider offers no cheap authenticated call to probe with. */
  | "no_probe"
  /** The request never completed: DNS, connection, or the timeout above. */
  | "unreachable"
  /** Something answered, but not with the success that would prove anything. */
  | "unexpected_status"
  /** The upstream refused the credential outright — the one negative verdict. */
  | "rejected";

export interface ProbeResult {
  /** `false` means "not proven good"; only `rejected` means "proven bad". */
  validated: boolean;
  reason?: ProbeReason;
  /** The status behind an `unexpected_status` or `rejected`, which names the fault. */
  status?: number;
}

/**
 * A probe has exactly two outcomes worth acting on: the upstream said the
 * credential is wrong, or it did not. Which of those blocks a write is the
 * caller's decision — see {@link assertNotRejected} — because a provider
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
    log("warn", "provider_probe_rejected", { probe: label, status: response.status });
    return { validated: false, reason: "rejected", status: response.status };
  }
  if (!response.ok) {
    // A gateway that holds no key for this provider answers here, so the status
    // is the only thing that tells the operator what to go and fix.
    log("warn", "provider_probe_inconclusive", { probe: label, status: response.status });
    return { validated: false, reason: "unexpected_status", status: response.status };
  }
  return { validated: true };
}

/**
 * Turns the one negative verdict a probe can reach into the refusal a write
 * must not swallow. Everything else passes through: an inconclusive probe is
 * not evidence against a credential the operator has reason to trust.
 */
export function assertNotRejected(result: ProbeResult): ProbeResult {
  if (result.reason !== "rejected") return result;
  throw new GatewayError(
    400,
    "provider_key_invalid",
    `The credential was rejected by the provider (HTTP ${result.status})`,
  );
}

export async function probeProviderKey(
  type: ProviderType,
  secret: string,
): Promise<ProbeResult> {
  const path = PROBE_PATHS[type];
  if (!path) return { validated: false, reason: "no_probe" };
  const spec = PROVIDER_REGISTRY[type];
  const headers: Record<string, string> = {
    [spec.auth.header]: `${"scheme" in spec.auth ? spec.auth.scheme : ""}${secret}`,
  };
  // Anthropic refuses any request without a version header, probe included.
  if (type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(type, `${spec.directBaseUrl}${path}`, headers);
}

/** Probes one provider through a reusable Cloudflare AI Gateway connection. */
export async function probeProviderGateway(input: {
  type: ProviderType;
  accountId: string;
  gatewayId: string;
  token: string;
}): Promise<ProbeResult> {
  const probePath = PROBE_PATHS[input.type];
  if (!probePath) return { validated: false, reason: "no_probe" };
  const spec = PROVIDER_REGISTRY[input.type];
  const prefix = "stripPathPrefix" in spec.aig ? spec.aig.stripPathPrefix : undefined;
  const path = prefix && probePath.startsWith(prefix)
    ? probePath.slice(prefix.length)
    : probePath;
  const url = [
    CF_AI_GATEWAY_BASE_URL,
    encodeURIComponent(input.accountId),
    encodeURIComponent(input.gatewayId),
    spec.aig.slug,
    path,
  ].join("/");
  const headers: Record<string, string> = {
    "cf-aig-authorization": `Bearer ${input.token}`,
  };
  if (input.type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(`${input.type}_via_cf_aig`, url, headers);
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
