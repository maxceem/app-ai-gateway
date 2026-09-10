import type { Capabilities } from "./types";

/**
 * The origin an application client calls, which is not always this console's.
 *
 * A deployment can serve the same Worker on a second host for apps while
 * operators stay on the console host; the console only learns about it from
 * `apiBaseUrl`. Falling back to the window origin is the self-hosted default
 * and what every deployment did before the setting existed.
 */
export function clientApiOrigin(capabilities: Capabilities | undefined): string {
  return capabilities?.apiBaseUrl ?? window.location.origin;
}
