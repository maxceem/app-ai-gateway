// `v2/package.json` is the one place the gateway's release is written. The
// bundler keeps only the named field, so the Worker carries the string and
// nothing else. The CLI is released with it under the same number
// (`cli/package.json`), which a test checks.
import { version } from "../../package.json";
import { PRICE_FILE } from "../pricing/price-file.ts";

/**
 * The gateway release this Worker is, as `GET /v2/console/capabilities`
 * reports it. The CLI compares it with its own release after a failure the
 * gateway answered (`version_mismatch`).
 */
export const SERVER_VERSION: string = version;

/**
 * Which model price list this Worker bills with. v1 named the commit that last
 * changed its list, which needs the deploy script to bake it in; v2's deploy
 * script comes later (plan step 13). Until then the revision is the first 12
 * hex digits of the list's SHA-256: it changes exactly when the prices do,
 * and a price deploy changes it without changing `SERVER_VERSION`. The day is
 * unknown without the commit, so it is null.
 */
export interface PricesRevision {
  readonly revision: string;
  readonly updated: string | null;
}

let prices: Promise<PricesRevision> | undefined;

/** The price list's revision, worked out once per isolate. */
export function pricesRevision(): Promise<PricesRevision> {
  prices ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(JSON.stringify(PRICE_FILE)))
    .then((digest) => ({
      revision: [...new Uint8Array(digest)]
        .slice(0, 6)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      updated: null,
    }));
  return prices;
}
