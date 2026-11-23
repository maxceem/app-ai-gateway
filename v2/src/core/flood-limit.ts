import { GatewayError } from "./errors.ts";

const encoder = new TextEncoder();

/**
 * One endpoint abuse policy: how often, over what, and how to say so.
 *
 * `action` names what the caller did too often and `sharedBy` what the counter
 * is taken over. Those two carry the whole difference between a limit the
 * caller can wait out alone and one that somebody else on the same network
 * already spent, which is the first thing a person needs in order to decide
 * what to do — and a bare count cannot tell them either.
 */
interface EndpointRateLimit {
  limit: number;
  windowMs: number;
  action: string;
  sharedBy: string;
}

/**
 * Every abuse policy this gateway enforces on its own endpoints.
 *
 * Each key is also the prefix of the subject it counts, so one name identifies
 * a policy here, in the Durable Object that counts it, and in the `scope` a
 * refusal reports. Changing a key renames the object and so forgives every
 * counter currently held under it; the numbers beside it can be changed freely.
 *
 * These are not a plan allowance and not an application's own limits. Nothing
 * here is bought, sold or configured by anyone, and neither quota system reads
 * this table: it exists only to stop one caller from hammering one endpoint.
 */
export const ENDPOINT_RATE_LIMITS = {
  app_auth_challenge: {
    limit: 60,
    windowMs: 60_000,
    action: "ask this app for a challenge",
    sharedBy: "everyone sharing your network address",
  },
  app_auth_register: {
    limit: 60,
    windowMs: 60_000,
    action: "register a key with this app",
    sharedBy: "everyone sharing your network address",
  },
  app_auth_token: {
    limit: 60,
    windowMs: 60_000,
    action: "exchange a token with this app",
    sharedBy: "everyone sharing your network address",
  },
  app_auth_failure: {
    limit: 60,
    windowMs: 60_000,
    action: "report a sign-in failure to this app",
    sharedBy: "everyone sharing your network address",
  },
  // Password sign-in is counted twice: the address counter stops one client
  // hammering the endpoint, and the email counter stops a spread of addresses
  // grinding through one account's passwords (v1's limits).
  sign_in_address: {
    limit: 10,
    windowMs: 60_000,
    action: "try to sign in",
    sharedBy: "everyone sharing your network address",
  },
  sign_in_email: {
    limit: 10,
    windowMs: 600_000,
    action: "try to sign in to one account",
    sharedBy: "everyone signing in to that email address",
  },
  // A sign-up answers whether its email is taken, so an unbounded one tests
  // addresses in bulk, and on a hosted deployment it makes throwaway accounts.
  sign_up_address: {
    limit: 10,
    windowMs: 3_600_000,
    action: "create a sign-in",
    sharedBy: "everyone sharing your network address",
  },
  // Each one sends an email to a real inbox. Five an hour covers a person who
  // missed the first and a few retries, and keeps the deployment's sender from
  // being turned on somebody's inbox (v1's limit).
  verification_email: {
    limit: 5,
    windowMs: 3_600_000,
    action: "send a verification email",
    sharedBy: "your sign-in",
  },
  // An OAuth authorization request is public, and one naming a client's
  // metadata document makes the gateway fetch it, so it is counted first.
  oauth_authorize: {
    limit: 30,
    windowMs: 600_000,
    action: "start an OAuth connection",
    sharedBy: "everyone sharing your network address",
  },
  // A CLI sign-in without a browser. Each one waits for a person, and one
  // declined at once frees its slot, so the engine's cap on waiting ones does
  // not bound how many are asked for.
  device_authorization: {
    limit: 20,
    windowMs: 3_600_000,
    action: "start a CLI sign-in",
    sharedBy: "everyone sharing your network address",
  },
  // Every write an agent hands to a person starts an operation: a loop that
  // opens or reserves and never finishes is held to v1's pace.
  operation: {
    limit: 10,
    windowMs: 60_000,
    action: "start a management operation",
    sharedBy: "your account",
  },
  // Each message opens a ticket and emails the support inbox: ten an hour covers
  // writing in about a problem and following up, and keeps one sign-in from
  // flooding the inbox (v1's limit).
  support_message: {
    limit: 10,
    windowMs: 3_600_000,
    action: "send a message to support",
    sharedBy: "your sign-in",
  },
  // Answering one approval link: a stranger guessing at keys or proofs for it.
  submission: {
    limit: 10,
    windowMs: 60_000,
    action: "answer an approval page",
    sharedBy: "this approval",
  },
  // A CLI sign-in code is eight characters, short enough to guess in bulk,
  // and looking one up is the only way a guess can be tried.
  user_code: {
    limit: 10,
    windowMs: 60_000,
    action: "look up a sign-in code",
    sharedBy: "everyone sharing your network address",
  },
} as const satisfies Record<string, EndpointRateLimit>;

export type EndpointRateLimitName = keyof typeof ENDPOINT_RATE_LIMITS;

/**
 * The caller's address, as the only header that cannot be set by the caller.
 *
 * `cf-connecting-ip` is written by Cloudflare's edge and overwritten on every
 * inbound request, so a client cannot choose its own counter. `x-forwarded-for`
 * is attacker-controlled and is never read here: trusting it would let one
 * client spend a different address's allowance, or spread its own attempts over
 * as many counters as it cares to invent. Direct `workerd` runs have no edge in
 * front of them and share the one `local` counter.
 *
 * An IPv6 address is counted as its /64. One client is routinely handed a
 * whole /64 and may send from any address in it, so counting each address
 * alone would multiply every per-address limit by as many as it cares to use.
 */
export function clientAddress(request: Request): string {
  const address = request.headers.get("cf-connecting-ip");
  if (address === null) return "local";
  return address.includes(":") ? (ipv6Network(address) ?? address) : address;
}

/**
 * The /64 an IPv6 address belongs to, in one spelling whichever form it came
 * in — `2001:db8:a:b::/64` — and an IPv4-mapped address as its IPv4 address.
 * Anything it cannot read is null, and is then counted as it is written.
 */
function ipv6Network(address: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail, ...rest] = address.toLowerCase().split("::");
  if (rest.length > 0) return null;
  const left = head === "" ? [] : head.split(":");
  const right = !tail ? [] : tail.split(":");
  // Only a `::` stands for zero groups, and it stands for at least one.
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const hex = groups.map((group) => group.padStart(4, "0")).join("");
  if (hex.startsWith("00000000000000000000ffff"))
    return [24, 26, 28, 30].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(".");
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

const UNITS = [
  { ms: 86_400_000, singular: "day", plural: "days" },
  { ms: 3_600_000, singular: "hour", plural: "hours" },
  { ms: 60_000, singular: "minute", plural: "minutes" },
  { ms: 1_000, singular: "second", plural: "seconds" },
] as const;

/** A duration as a person says it, in the largest unit that fits it whole. */
function spoken(ms: number): string {
  for (const unit of UNITS) {
    if (ms < unit.ms) continue;
    const count = Math.floor(ms / unit.ms);
    return `${count} ${count === 1 ? unit.singular : unit.plural}`;
  }
  return "1 second";
}

/** The same duration as the unit alone, for "at most 3 times per day". */
function perWindow(ms: number): string {
  const text = spoken(ms);
  return text.startsWith("1 ") ? text.slice(2) : text;
}

async function subjectDigest(subject: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(subject)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}


/**
 * Enforces a gateway endpoint's fixed-window abuse policy for one subject.
 *
 * `scopeId` is whatever the policy counts over — a network address, an account,
 * one pending operation — and never reaches the Durable Object's name in the
 * clear, because the digest below is what the object is named after.
 */
export async function enforceEndpointRateLimit(
  env: Env,
  name: EndpointRateLimitName,
  scopeId: string,
): Promise<void> {
  const policy = ENDPOINT_RATE_LIMITS[name];
  const subject = `${name}:${scopeId}`;
  const objectName = `endpoint-rate:${await subjectDigest(subject)}`;
  const result = await env.FLOOD_LIMITER
    .getByName(objectName)
    .check({ limit: policy.limit, windowMs: policy.windowMs });
  if (result.allowed) return;

  const resetAt = new Date(
    Date.now() + result.retryAfterSeconds * 1_000,
  ).toISOString();
  // A wait measured in seconds is best said as a wait. One measured in hours is
  // best said as an instant: the window is aligned to the clock rather than to
  // the caller's last attempt, so "about 18 hours" is the one part of this they
  // would otherwise have to work out for themselves.
  const retry =
    result.retryAfterSeconds >= 3_600
      ? `Try again after ${resetAt}.`
      : `Try again in ${spoken(result.retryAfterSeconds * 1_000)}.`;
  throw new GatewayError(
    429,
    "rate_limited",
    `You can ${policy.action} at most ${policy.limit} times per ` +
      `${perWindow(policy.windowMs)}, counted across ${policy.sharedBy}. ${retry}`,
    { "Retry-After": String(result.retryAfterSeconds) },
    {
      data: {
        scope: name,
        limit: policy.limit,
        windowSeconds: policy.windowMs / 1_000,
        retryAfterSeconds: result.retryAfterSeconds,
        resetAt,
      },
    },
  );
}

/**
 * Whether this is the first sample of `scopeId` in its window, for diagnostics
 * that are sampled rather than written for every event (v1's rejection events).
 */
export async function claimDiagnosticSample(
  env: Env,
  category: string,
  scopeId: string,
  windowMs: number,
): Promise<boolean> {
  const objectName = `diagnostic-${category}:${await subjectDigest(`${category}:${scopeId}`)}`;
  const result = await env.FLOOD_LIMITER.getByName(objectName).check({ limit: 1, windowMs });
  return result.allowed;
}
