/**
 * The network a request came from, as Cloudflare names it: the autonomous
 * system number and that system's name, such as `714` and `Apple Inc.`.
 *
 * A network, never an address: it tells an operator that a failure came from
 * a mobile carrier, a cloud host or Apple's own network (where App Review
 * tests apps), without saying which person or device it was. Cloudflare sets
 * both values; the caller cannot.
 */
export interface ClientNetwork {
  asn: number | null;
  name: string | null;
}

/** Longer than any network name Cloudflare reports; anything past it is cut. */
const NETWORK_NAME_MAX_LENGTH = 100;

/** Printable text only, so a name can never carry a control character into a row or a log. */
const PRINTABLE = /^[\x20-\x7e -￿]+$/u;

export function clientNetwork(request: Request): ClientNetwork {
  const cf = (request as { cf?: { asn?: unknown; asOrganization?: unknown } }).cf;
  const asn = typeof cf?.asn === "number" && Number.isInteger(cf.asn) && cf.asn > 0 ? cf.asn : null;
  const raw = typeof cf?.asOrganization === "string" ? cf.asOrganization.trim().slice(0, NETWORK_NAME_MAX_LENGTH) : "";
  return { asn, name: raw.length > 0 && PRINTABLE.test(raw) ? raw : null };
}
