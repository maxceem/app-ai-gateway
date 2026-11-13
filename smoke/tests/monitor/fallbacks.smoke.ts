import { expect, test } from "vitest";
import { countLogMessages } from "../../src/logs.ts";
import { env } from "../support.ts";

// Whether the gateway is quietly riding out a problem. When D1, the plan
// allowance's counter or billing is slow or failing, apps are still served —
// from records the gateway already knew, or uncounted — and every other check
// stays green. These are the log lines that say so; any of them in the last
// four and a half minutes fails this check.
//
// Run it every five minutes. The look-back is a little shorter than that,
// because a scheduler may start a run a few seconds early and a run takes a
// varying moment to reach its query: two runs then never look at the same
// moment, so a blip fails one run only, and a monitor that alerts after two
// failures in a row alerts on fallbacks that lasted. Fallbacks that last are
// in every look-back; only a blip in the half-minute between two can go unseen.
//
// It reads the deployment's Worker logs, so it needs a read-only Cloudflare
// token (SMOKE_CF_API_TOKEN, SMOKE_CF_ACCOUNT_ID) and is skipped without one.

const WINDOW_MS = 4.5 * 60_000;

/** Each is logged by the gateway when it serves a request in a degraded way. */
const FALLBACKS = [
  // A stalled D1 read was answered from a record this isolate knew.
  "known_record_served",
  // The plan allowance's counter could not answer; the request was served uncounted.
  "allowance_uncounted",
  // Billing was too slow to answer an app's request.
  "billing_access_slow",
  // A usage event could not be written, and its spend was lost.
  "usage_record_failed",
] as const;

test.skipIf(env.cloudflare === undefined)(
  "the gateway served apps without falling back in the last few minutes",
  async () => {
    const counts = await countLogMessages(env.cloudflare!, FALLBACKS, WINDOW_MS);
    const used = Object.entries(counts).map(([message, count]) => `${message} ×${count}`);
    expect(used, `fallbacks in the last ${WINDOW_MS / 60_000} minutes: ${used.join(", ")}`).toEqual([]);
  },
);
