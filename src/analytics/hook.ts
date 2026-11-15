/**
 * The optional `ANALYTICS` service binding, and everything this gateway ever
 * sends it.
 *
 * A deployment may bind a Worker of its own as `ANALYTICS` to be told when an
 * account is created, for its own sign-up reporting. The open-source
 * deployment binds nothing, and then nothing here runs: no cookie is read and
 * no call is made.
 *
 * What leaves is exactly {@link AccountCreated}: two opaque identifiers, a time,
 * the country the sign-up came from, and where the visitor first came from —
 * unless the browser sends Do Not Track, and then neither of the last two. No credential, request, header, email
 * address or name ever reaches the binding, because nothing here is given one.
 * The event is built field by field from plain values, never by spreading an
 * object, so a field added anywhere else cannot ride along.
 *
 * The call is one-way and after the fact: it runs after the account is saved,
 * through `waitUntil`, its result is ignored and a failure is only logged, so
 * the bound Worker can neither slow down nor change a sign-up.
 *
 * Keep this file free of anything else. Like `src/billing/contract.ts`, it is a
 * wire contract with whatever Worker is bound on the other side.
 */
import { errorFacts } from "../core/error-facts";
import { log } from "../core/log";

/** The whole RPC surface the gateway calls. */
export interface AnalyticsHook {
  accountCreated(event: AccountCreated): Promise<void>;
}

export interface AccountCreated {
  /** The account's id. Random; carries no personal data. */
  accountId: string;
  /** The person who created or claimed it. Random; carries no personal data. */
  userId: string;
  /** `created` for a new account, `claimed` when a person takes over one an agent provisioned. */
  kind: "created" | "claimed";
  /** When this gateway saw it, as an ISO 8601 string. */
  occurredAt: string;
  /**
   * The two-letter country Cloudflare placed the sign-up request in, such as
   * `US`. Null when it is unknown or the browser sends Do Not Track.
   */
  country: string | null;
  /** Where the visitor first came from, or null when the browser sent no {@link FIRST_TOUCH_COOKIE}. */
  firstTouch: FirstTouch | null;
}

/** Each field is checked and bounded by {@link readFirstTouch}; anything that fails is null. */
export interface FirstTouch {
  /** The host of the page that referred the first visit, such as `github.com`. */
  referrerHost: string | null;
  /** The path the first visit landed on, without its query or fragment. */
  landingPath: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  /** When that first visit happened, as an ISO 8601 string. */
  firstSeenAt: string | null;
  /** The anonymous id the site's own analytics gave that visitor, so the two can be joined. */
  visitorId: string | null;
}

/**
 * The one cookie this reads, by this fixed name. A deployment's own website
 * sets it on a first visit, on a parent domain the console shares. It is a
 * constant rather than a setting so that no configuration can point this at
 * a sign-in cookie.
 */
export const FIRST_TOUCH_COOKIE = "first_touch";

/** Past this length the cookie is ignored outright rather than parsed. */
const MAX_COOKIE_LENGTH = 1024;
const MAX_TEXT_LENGTH = 100;
const MAX_PATH_LENGTH = 200;
/** No first visit predates this; anything earlier is not a time this site wrote. */
const EARLIEST_FIRST_SEEN_MS = Date.UTC(2025, 0, 1);

const HOST = /^[a-z0-9.-]{1,253}$/;
const VISITOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Printable ASCII, no space: what a URL path is made of once encoded. */
const PATH = /^\/[\x21-\x7e]*$/;
/** Printable ASCII including space, for campaign labels. */
const TEXT = /^[\x20-\x7e]+$/;
const EPOCH_MS = /^\d{13}$/;
/** ISO 3166-1 alpha-2, plus Cloudflare's `T1` for Tor. `XX` means unknown. */
const COUNTRY = /^[A-Z][A-Z0-9]$/;

/** A country code as Cloudflare gives it, or null when it is unknown or malformed. */
export function readCountry(value: unknown): string | null {
  return typeof value === "string" && COUNTRY.test(value) && value !== "XX" ? value : null;
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT_LENGTH && TEXT.test(trimmed) ? trimmed : null;
}

function path(value: string | null): string | null {
  if (value === null || value.length > MAX_PATH_LENGTH || !PATH.test(value)) return null;
  return value.includes("?") || value.includes("#") ? null : value;
}

function host(value: string | null): string | null {
  const lowered = value?.toLowerCase() ?? "";
  return HOST.test(lowered) ? lowered : null;
}

function firstSeen(value: string | null, now: number): string | null {
  if (value === null || !EPOCH_MS.test(value)) return null;
  const ms = Number(value);
  return ms >= EARLIEST_FIRST_SEEN_MS && ms <= now + 86_400_000 ? new Date(ms).toISOString() : null;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * The first-visit cookie, if the browser sent one, reduced to the checked
 * fields of {@link FirstTouch}. The value is a URL-encoded query string, such
 * as `r=github.com&p=%2F&t=1767225600000`. Nothing else in the `Cookie` header
 * is read.
 */
export function readFirstTouch(cookieHeader: string | undefined, now = Date.now()): FirstTouch | null {
  const raw = cookieValue(cookieHeader, FIRST_TOUCH_COOKIE);
  if (raw === null || raw.length === 0 || raw.length > MAX_COOKIE_LENGTH) return null;
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(decodeURIComponent(raw));
  } catch {
    return null;
  }
  const visitorId = fields.get("v");
  const touch: FirstTouch = {
    referrerHost: host(fields.get("r")),
    landingPath: path(fields.get("p")),
    utmSource: text(fields.get("us")),
    utmMedium: text(fields.get("um")),
    utmCampaign: text(fields.get("uc")),
    firstSeenAt: firstSeen(fields.get("t"), now),
    visitorId: visitorId !== null && VISITOR_ID.test(visitorId) ? visitorId : null,
  };
  return Object.values(touch).some((value) => value !== null) ? touch : null;
}

/** What of the request {@link accountNotifier} needs: two headers, read only on an event, and `waitUntil`. */
export interface AnalyticsRequest {
  cookieHeader(): string | undefined;
  /** The browser's Do Not Track header (`DNT`), if it sent one. */
  doNotTrackHeader(): string | undefined;
  /** Cloudflare's country for this request (`request.cf.country`), if any. */
  country(): unknown;
  waitUntil(promise: Promise<unknown>): void;
}

export type AccountNotifier = (event: {
  accountId: string;
  userId: string;
  kind: AccountCreated["kind"];
}) => void;

/**
 * A notifier for this request, or null when no `ANALYTICS` binding is set —
 * in which case the caller has nothing to call and nothing is read.
 */
export function accountNotifier(env: Env, request: AnalyticsRequest): AccountNotifier | null {
  const hook = env.ANALYTICS;
  if (!hook) return null;
  return ({ accountId, userId, kind }) => {
    const doNotTrack = request.doNotTrackHeader()?.trim() === "1";
    const event: AccountCreated = {
      accountId,
      userId,
      kind,
      occurredAt: new Date().toISOString(),
      // A browser that asks not to be tracked signs up with no source and no
      // country, even if it still holds a first-visit cookie from before it asked.
      country: doNotTrack ? null : readCountry(request.country()),
      firstTouch: doNotTrack ? null : readFirstTouch(request.cookieHeader()),
    };
    request.waitUntil(
      Promise.resolve()
        .then(() => hook.accountCreated(event))
        .catch((error: unknown) => {
          log("warn", "analytics_hook_failed", { kind, error: errorFacts(error) });
        }),
    );
  };
}
