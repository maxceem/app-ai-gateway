/**
 * Apple's own network, by its autonomous system number. App Review tests apps
 * from it, so a sign-in failing there most likely failed for a reviewer.
 *
 * Only a way of reading a network the gateway records for every
 * authentication event, not a separate kind of failure: the console gives a
 * failure on this network extra attention, and nothing else treats it
 * differently.
 */
export const APPLE_NETWORK_ASN = 714;

export function isAppleNetwork(asn: number | null | undefined): boolean {
  return asn === APPLE_NETWORK_ASN;
}

/** `Apple Inc. (AS714)`, or whichever half is known. */
export function networkLabel(asn: number | null | undefined, name: string | null | undefined): string | null {
  if (asn == null) return name ?? null;
  return name ? `${name} (AS${asn})` : `AS${asn}`;
}
