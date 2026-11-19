/**
 * Testing a provider key before it is saved (v1's provider probe, ported).
 *
 * The test sends one free `GET` that needs a valid key, to the same origin
 * live requests would use. Only a 401 or 403 says the key is wrong. Anything
 * else (no answer, a 404 from a custom base URL, a provider with no free
 * call) proves nothing either way, and must never stop someone from saving a
 * key they know is right. Saving never runs this test, as v1.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import type { ProviderDescription } from "../providers/operation.ts";

const PROBE_TIMEOUT_MS = 4_000;

export type ProbeResult =
  | { validated: true }
  | { validated: false; reason: "no_probe" | "unreachable" }
  | { validated: false; reason: "unexpected_status" | "rejected"; status: number };

/** `origin` ends with `/`: the connection's base URL, or the provider's own host. */
export async function probeProviderKey(description: ProviderDescription, origin: string, secret: string): Promise<ProbeResult> {
  if (description.probe === undefined) return { validated: false, reason: "no_probe" };
  const headers = new Headers();
  // A callback, so a key containing `$&` is sent as it is.
  headers.set(description.auth.header, description.auth.format.replace("{key}", () => secret));
  let response: Response;
  try {
    response = await fetch(`${origin}${description.probe.path}`, {
      method: "GET",
      headers,
      // Never follow a redirect: it could take the key to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    log("warn", "provider_probe_unreachable", { providerType: description.type, error: errorFacts(error) });
    return { validated: false, reason: "unreachable" };
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    log("warn", "provider_probe_rejected", { providerType: description.type, status: response.status });
    return { validated: false, reason: "rejected", status: response.status };
  }
  if (!response.ok) {
    log("warn", "provider_probe_inconclusive", { providerType: description.type, status: response.status });
    return { validated: false, reason: "unexpected_status", status: response.status };
  }
  return { validated: true };
}
