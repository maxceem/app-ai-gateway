import { GatewayError } from "./errors";
import { gatewayProbe, type ResolvedGateway } from "./gateways";
import { log } from "./log";
import { PROVIDER_REGISTRY, providerAuthValue } from "./providers";
import type { ProviderType } from "./types";

/**
 * The cheapest authenticated call each provider offers, as a path under its own
 * {@link PROVIDER_REGISTRY} base URL. A type is absent only when the provider
 * has no such call, and its credentials are then accepted unvalidated and
 * flagged in the console — never because a plausible path was untested. An entry
 * that answers 200 to an invalid key would be worse than no entry at all: it
 * would report every key as good.
 *
 * Absent, and why:
 * - `perplexity` — no unmetered authenticated endpoint.
 * - `fireworks` — its list-models call is `v1/accounts/{account}/models`, and
 *   the account id cannot be derived from the key. Nothing under
 *   `inference/v1/` is documented as a GET.
 * - `huggingface` — `router.huggingface.co/v1/models` is public: it answers 200
 *   to a garbage token, so probing it would validate every key. The endpoint
 *   that does check a token lives on a different origin (`huggingface.co`),
 *   which this table cannot express.
 * - `bytedance` — ModelArk publishes no list-models call, and its own SDK has
 *   no models resource. It also authenticates before it routes, so every path
 *   answers the same 401 and a probe would prove nothing about the key.
 */
const PROBE_PATHS: Partial<Record<ProviderType, string>> = {
  openai: "v1/models",
  xai: "v1/models",
  gemini: "v1beta/models",
  anthropic: "v1/models",
  // DeepSeek's OpenAI base URL carries no `v1` segment.
  deepseek: "models",
  // Groq's OpenAI-compatible surface is namespaced under `openai/`.
  groq: "openai/v1/models",
  mistral: "v1/models",
  together: "v1/models",
  cerebras: "v1/models",
  moonshot: "v1/models",
  baseten: "v1/models",
  // OpenRouter's key-status call, not its model list: `v1/models` is public and
  // answers 200 to any token, exactly the trap `huggingface` is absent for.
  // `v1/key` answers 401 to a key that does not exist.
  openrouter: "v1/key",
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
 * Probes one provider through a reusable gateway connection. The URL and the
 * gateway auth header come from the adapter that serves live traffic, so a
 * probe can never test a route production does not use — and the adapter
 * decides whether the provider's own path is even the right thing to call.
 */
export async function probeProviderGateway(input: {
  type: ProviderType;
  gateway: ResolvedGateway;
  token: string;
}): Promise<ProbeResult> {
  const request = gatewayProbe({
    gateway: input.gateway,
    secret: input.token,
    provider: input.type,
    // Null where this provider has no cheap authenticated call of its own. A
    // gateway that authenticates with its own credential still has one.
    path: PROBE_PATHS[input.type] ?? null,
  });
  // Nothing to prove: either this gateway does not serve the provider type, or
  // the only thing it could call is a provider path that does not exist.
  if (!request) return { validated: false, reason: "no_probe" };
  const headers: Record<string, string> = { ...request.headers };
  if (input.type === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return runProbe(`${input.type}_via_${input.gateway.type}`, request.url, headers);
}

/**
 * Proves a whole gateway connection — every non-secret field plus the token —
 * in one call, which is exactly the set of mistakes the create form can
 * produce. `openai` is the stand-in provider: Cloudflare's URL needs *some*
 * provider slug to be a URL at all, and Vercel's probe is provider-independent
 * because its credential is, so both adapters answer for the connection itself.
 */
export async function probeGatewayPreset(
  gateway: ResolvedGateway,
  token: string,
): Promise<ProbeResult> {
  return probeProviderGateway({ type: "openai", gateway, token });
}
