/**
 * Job ids the gateway hands to apps (plan D9).
 *
 * A job id is signed by the gateway and carries everything a poll needs: the
 * provider connection, the operation, the model, the provider's request id,
 * and the account, app and end user the job belongs to. So:
 *
 * - checking who owns a job needs no D1 lookup;
 * - the upstream URL of a poll is built from the signed id, never from the
 *   client's path, so one app can never read another app's job result;
 * - polls work while D1 is down.
 *
 * The id is `j1.<claims>.<signature>`, both parts base64url. The signature is
 * an HMAC over the claims, with a key derived from `JWT_SECRET` for this use
 * alone, so a job id can never pass as a gateway token or the other way round.
 * `JWT_SECRET` must be at least 32 bytes, as for gateway tokens: a shorter or
 * missing one signs nothing and verifies nothing, never a predictable key.
 *
 * The end user is carried as a fixed-length digest of its id, so a long id
 * never makes the job id too long, and the caller's id is compared by digest.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { ttlCache } from "../core/ttl-cache.ts";

/** What a job id says. Short names keep the id short: it is a URL path segment. */
export interface JobClaims {
  /** The gateway's own id of the job: the owner of its charges. */
  readonly job: string;
  readonly connectionId: string;
  readonly slug: string;
  readonly operation: string;
  readonly model: string;
  /** The provider's id of the job. */
  readonly requestId: string;
  readonly accountId: string;
  readonly appId: string;
  /** A digest of the end user's id (`userDigest`), or null for none. */
  readonly userDigest: string | null;
  readonly issuedAt: number;
}

/** What signing takes: the claims, with the end user's own id, which is signed as its digest. */
export type JobClaimsInput = Omit<JobClaims, "userDigest"> & { readonly userId: string | null };

interface WireClaims {
  readonly k: string;
  readonly c: string;
  readonly s: string;
  readonly o: string;
  readonly m: string;
  readonly r: string;
  readonly a: string;
  readonly p: string;
  readonly u: string | null;
  readonly t: number;
}

const PREFIX = "j1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Derived keys by secret, made once each. */
const keys = ttlCache<string, Promise<CryptoKey>>({ name: "job-id-key", ttlMs: Number.POSITIVE_INFINITY, maxEntries: 8 });

/** The shortest secret job ids are signed with, the same as for gateway tokens. */
const MIN_SECRET_BYTES = 32;

/** Whether `secret` can sign and verify job ids. */
export function jobSigningReady(secret: string | undefined): secret is string {
  return typeof secret === "string" && encoder.encode(secret).byteLength >= MIN_SECRET_BYTES;
}

/** The error for a gateway whose `JWT_SECRET` cannot sign job ids. Logged, so the monitor alerts. */
export function jobSigningUnavailable(): GatewayError {
  log("error", "job_signing_secret_invalid", {});
  return new GatewayError(500, "internal_error", "JWT_SECRET must be at least 32 bytes");
}

function signingKey(secret: string): Promise<CryptoKey> {
  if (!jobSigningReady(secret)) throw jobSigningUnavailable();
  const cached = keys.get(secret);
  if (cached !== undefined) return cached;
  const made = (async () => {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("app-ai-gateway v2 job id") },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  })();
  made.catch(() => {
    if (keys.get(secret) === made) keys.delete(secret);
  });
  keys.set(secret, made);
  return made;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** The bytes of a base64url text, or null. Only the one canonical spelling is read, so each job has one id. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  return toBase64Url(bytes) === text ? bytes : null;
}

/** A fixed-length digest of an end user's id, as job ids carry it, or null for none. */
export async function userDigest(userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(userId))));
}

/** A signed job id for `claims`. Throws when `JWT_SECRET` cannot sign. */
export async function signJobId(secret: string, claims: JobClaimsInput): Promise<string> {
  const wire: WireClaims = {
    k: claims.job,
    c: claims.connectionId,
    s: claims.slug,
    o: claims.operation,
    m: claims.model,
    r: claims.requestId,
    a: claims.accountId,
    p: claims.appId,
    u: await userDigest(claims.userId),
    t: claims.issuedAt,
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(wire)));
  const signed = `${PREFIX}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(signed)));
  return `${signed}.${toBase64Url(signature)}`;
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The claims of a job id the gateway signed, or null for anything else:
 * forged, altered or malformed, or read while `JWT_SECRET` cannot verify.
 */
export async function readJobId(secret: string | undefined, id: string): Promise<JobClaims | null> {
  if (!jobSigningReady(secret)) {
    log("error", "job_signing_secret_invalid", {});
    return null;
  }
  if (id.length > 2048) return null;
  const parts = id.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const signature = fromBase64Url(parts[2]!);
  const body = fromBase64Url(parts[1]!);
  if (signature === null || body === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signature as Uint8Array<ArrayBuffer>,
    encoder.encode(`${PREFIX}.${parts[1]}`),
  );
  if (!valid) return null;
  let wire: Partial<WireClaims>;
  try {
    wire = JSON.parse(decoder.decode(body)) as Partial<WireClaims>;
  } catch {
    return null;
  }
  if (![wire.k, wire.c, wire.s, wire.o, wire.m, wire.r, wire.a, wire.p].every(text)) return null;
  if (!(wire.u === null || text(wire.u)) || typeof wire.t !== "number") return null;
  return {
    job: wire.k!,
    connectionId: wire.c!,
    slug: wire.s!,
    operation: wire.o!,
    model: wire.m!,
    requestId: wire.r!,
    accountId: wire.a!,
    appId: wire.p!,
    userDigest: wire.u ?? null,
    issuedAt: wire.t,
  };
}
