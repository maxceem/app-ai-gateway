import type { GatewayType, ProviderGatewayConfig } from "../db/schema";
import { GatewayError } from "./errors";
import { log } from "./log";
import { providerProbeHeaders } from "./providers";
import { DIRECT_ADAPTER, routeAdapter, type RouteRequest } from "./routes";
import type { ProviderType } from "./types";

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
 * What is left of a {@link ProbeResult} once {@link assertNotRejected} has had
 * it: the same shape without the one verdict that raises instead of returning.
 * Named because it is what the providers dry run answers with, and its
 * published contract says so.
 */
export type InconclusiveProbeResult = Omit<ProbeResult, "reason"> & {
  reason?: Exclude<ProbeReason, "rejected">;
};

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
export function assertNotRejected(result: ProbeResult): InconclusiveProbeResult {
  if (result.reason !== "rejected") return result as InconclusiveProbeResult;
  throw new GatewayError(
    400,
    "provider_key_invalid",
    `The credential was rejected by the provider (HTTP ${result.status})`,
  );
}

/**
 * `baseUrl` is the row's operator-supplied origin, already canonicalized by the
 * origin guard. Probing the same origin live traffic will use is the point: it
 * is what turns a mistyped Azure or vLLM URL into a failure at configuration
 * time rather than on the app's first request. A custom endpoint that does not
 * implement the provider's list-models call answers 404, which is inconclusive
 * rather than a refusal, so the operator can still save a URL they know is
 * right.
 */
export async function probeProviderKey(
  type: ProviderType,
  secret: string,
  baseUrl?: string | null,
): Promise<ProbeResult> {
  const request = DIRECT_ADAPTER.probe({
    provider: type,
    secret,
    baseUrl: baseUrl ?? null,
    gatewayConfig: null,
  });
  // Null where this provider type has no cheap authenticated call of its own;
  // the reason lives with the descriptor that declines to name one.
  if (!request) return { validated: false, reason: "no_probe" };
  return runProbe(type, request.url, probeHeaders(type, request));
}

/**
 * The provider's own probe requirements travel with it on every route: a
 * Cloudflare route forwards to Anthropic's real API, which refuses a request
 * with no version header however it arrived. The adapter's own headers win,
 * because they are the credential this call is proving.
 */
function probeHeaders(type: ProviderType, request: RouteRequest): Record<string, string> {
  return { ...providerProbeHeaders(type), ...request.headers };
}

/**
 * Probes one provider through a reusable gateway connection. The URL and the
 * gateway auth header come from the adapter that serves live traffic, so a
 * probe can never test a route production does not use — and the adapter
 * decides whether the provider's own path is even the right thing to call.
 */
export async function probeProviderGateway(input: {
  type: ProviderType;
  gatewayType: GatewayType;
  gatewayConfig: ProviderGatewayConfig;
  token: string;
}): Promise<ProbeResult> {
  const request = routeAdapter(input.gatewayType).probe({
    provider: input.type,
    secret: input.token,
    baseUrl: null,
    gatewayConfig: input.gatewayConfig,
  });
  // Nothing to prove: either this gateway does not serve the provider type, or
  // the only thing it could call is a provider path that does not exist.
  if (!request) return { validated: false, reason: "no_probe" };
  return runProbe(`${input.type}_via_${input.gatewayType}`, request.url, probeHeaders(input.type, request));
}

/**
 * Proves a whole gateway connection — every non-secret field plus the token —
 * in one call, which is exactly the set of mistakes the create form can
 * produce. `openai` is the stand-in provider: Cloudflare's URL needs *some*
 * provider slug to be a URL at all, and Vercel's probe is provider-independent
 * because its credential is, so both adapters answer for the connection itself.
 */
export async function probeGatewayPreset(
  gateway: { type: GatewayType; config: ProviderGatewayConfig },
  token: string,
): Promise<ProbeResult> {
  return probeProviderGateway({
    type: "openai",
    gatewayType: gateway.type,
    gatewayConfig: gateway.config,
    token,
  });
}
