/**
 * Testing a provider key before it is saved (v1's provider probe, ported).
 *
 * The test sends one free `GET` that needs a valid key, to the same origin
 * live requests would use. Only a 401 says the key is probably wrong. A 403
 * means the key works but may not list models. That, and anything else (no
 * answer, a 404 from a custom base URL, a provider with no free call), proves
 * nothing either way, and must never stop someone from saving a key they know
 * is right. Saving never runs this test, as v1.
 *
 * The key to test is sealed first, under a connection id of "", and sent
 * through the vault like any live call (plan step 8i): this Worker never
 * adds a key to a request itself.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import type { ProviderDescription } from "../providers/operation.ts";
import type { SealedUpstreamRequest } from "../providers/route.ts";
import { vault } from "../vault/client.ts";

const PROBE_TIMEOUT_MS = 4_000;

export type ProbeResult =
  | { validated: true }
  | { validated: false; reason: "no_probe" | "unreachable" }
  | { validated: false; reason: "unexpected_status" | "rejected"; status: number };

/**
 * Seals the key and sends the provider's probe (built where live requests are
 * built, `src/providers/route.ts`), both under one time limit, so the test
 * reaches the same host with the same credentials. `build` is null for a
 * provider with no probe. A seal or send that fails or runs out of time
 * proves nothing: `unreachable`.
 */
export async function probeProviderKey(
  env: Env,
  description: ProviderDescription,
  build: (() => Promise<SealedUpstreamRequest>) | null,
): Promise<ProbeResult> {
  if (description.probe === undefined || build === null) return { validated: false, reason: "no_probe" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("provider probe timed out")), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
    });
    const probe = await Promise.race([build(), timedOut]);
    const headers = new Headers(description.probe.headers);
    for (const [name, value] of Object.entries(probe.headers)) headers.set(name, value);
    // The vault never follows a redirect: it could take the key to another host.
    response = await Promise.race([
      vault(env).call({ url: probe.url, method: "GET", headers, body: null, signal: deadline.signal, credentials: probe.credentials }),
      timedOut,
    ]);
  } catch (error) {
    log("warn", "provider_probe_unreachable", { providerType: description.type, error: errorFacts(error) });
    return { validated: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  await response.body?.cancel();
  if (response.status === 401) {
    log("warn", "provider_probe_rejected", { providerType: description.type, status: response.status });
    return { validated: false, reason: "rejected", status: response.status };
  }
  if (!response.ok) {
    log("warn", "provider_probe_inconclusive", { providerType: description.type, status: response.status });
    return { validated: false, reason: "unexpected_status", status: response.status };
  }
  return { validated: true };
}
