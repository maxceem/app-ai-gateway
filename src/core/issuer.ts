import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWK,
} from "jose";
import { GatewayError } from "./errors";
import type { ClaimRequirement, IssuerAuthConfig } from "./types";

interface JwksCacheEntry {
  expiresAt: number;
  keys: JWK[];
}

const jwksCache = new Map<string, JwksCacheEntry>();
const JWKS_TTL_MS = 10 * 60_000;
const ALLOWED_ISSUER_ALGORITHMS = new Set(["RS256", "PS256", "ES256", "ES384", "ES512", "EdDSA"]);

/**
 * Why one issuer token was refused. Log- and event-only: several of these share
 * a single client-facing code, because the client's correct response to them is
 * the same. Free to grow — nothing downstream matches on the full set.
 */
export type IssuerRejectionReason =
  | "jwks_unreachable"
  | "jwks_invalid"
  | "header_invalid"
  | "unknown_kid"
  | "alg_mismatch"
  | "bad_signature"
  | "timestamps_invalid"
  | "expired"
  | "lifetime_exceeded"
  | "claims_missing"
  | "user_id_missing";

async function fetchJwks(url: string): Promise<JWK[]> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    reject("jwks_unreachable");
  }
  if (!response.ok) reject("jwks_unreachable");
  let body: JSONWebKeySet;
  try {
    body = (await response.json()) as JSONWebKeySet;
  } catch {
    // A 200 carrying an HTML error page or a truncated body is still the
    // gateway failing to read the issuer's keys, not a verdict on the token.
    // Left to propagate, the parse error would land in the catch-all below and
    // be reported as a bad signature — blaming the caller's credential for an
    // outage upstream of it.
    reject("jwks_invalid");
  }
  if (!Array.isArray(body.keys)) reject("jwks_invalid");
  const keys = body.keys.filter((key): key is JWK => typeof key === "object" && key !== null);
  jwksCache.set(url, { expiresAt: Date.now() + JWKS_TTL_MS, keys });
  return keys;
}

async function keysFor(url: string): Promise<JWK[]> {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  return fetchJwks(url);
}

function claimAtPath(payload: JWTPayload, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function containsClaim(actual: unknown, expected: string): boolean {
  if (Array.isArray(actual)) return actual.some((value) => value === expected);
  if (typeof actual !== "string") return false;
  return actual === expected || actual.split(/\s+/u).filter(Boolean).includes(expected);
}

function requirementMatches(payload: JWTPayload, requirement: ClaimRequirement): boolean {
  const actual = claimAtPath(payload, requirement.path);
  if (requirement.contains !== undefined) {
    const expected = Array.isArray(requirement.contains) ? requirement.contains : [requirement.contains];
    return expected.some((value) => containsClaim(actual, value));
  }
  return actual === requirement.equals;
}

/**
 * Turns a cause into the one code its client behaviour class deserves.
 *
 * There are three of them, and no more: a client can only do three things about
 * a refused exchange — get a fresh token, wait for an entitlement to arrive, or
 * back off because the gateway itself could not answer. Splitting the codes any
 * finer would publish internals nobody can act on differently; keeping them
 * merged is what made the entitlement gap indistinguishable from a forged token.
 */
function reject(reason: IssuerRejectionReason, userId?: string): never {
  if (reason === "claims_missing") {
    throw new GatewayError(
      403,
      "issuer_claims_missing",
      // Read standalone: clients built before this code existed decode it as
      // unknown and show this message verbatim.
      "Issuer token is valid, but a required entitlement claim is not present yet",
      undefined,
      { reason, userId },
    );
  }
  if (reason === "jwks_unreachable" || reason === "jwks_invalid") {
    throw new GatewayError(
      503,
      "issuer_verification_unavailable",
      "Issuer keys are temporarily unavailable",
      undefined,
      { reason },
    );
  }
  throw new GatewayError(403, "issuer_token_rejected", "Issuer token was rejected", undefined, {
    reason,
    userId,
  });
}

export async function verifyIssuerToken(
  token: string,
  config: IssuerAuthConfig,
  options: { skipRequiredClaims?: boolean } = {},
): Promise<{ userId: string; payload: JWTPayload }> {
  try {
    const header = decodeProtectedHeader(token);
    if (typeof header.kid !== "string" || typeof header.alg !== "string") reject("header_invalid");
    if (!ALLOWED_ISSUER_ALGORITHMS.has(header.alg)) reject("alg_mismatch");

    let keys = await keysFor(config.jwks_url);
    let jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      keys = await fetchJwks(config.jwks_url);
      jwk = keys.find((candidate) => candidate.kid === header.kid);
    }
    if (!jwk) reject("unknown_kid");
    if (jwk.alg !== undefined && jwk.alg !== header.alg) reject("alg_mismatch");

    const publicKey = await importJWK(jwk, header.alg);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [...ALLOWED_ISSUER_ALGORITHMS],
    });
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") reject("timestamps_invalid");
    if (payload.exp <= Math.floor(Date.now() / 1000)) reject("expired");
    if (payload.exp <= payload.iat || payload.exp - payload.iat > config.max_token_lifetime_seconds) {
      reject("lifetime_exceeded");
    }

    // Read before the claims check, not after: the signature is verified by
    // now, so this identity is trustworthy, and a claims-missing rejection is
    // the one rejection that has to name *who* is waiting for an entitlement.
    const userId = claimAtPath(payload, config.user_id_claim);
    if (typeof userId !== "string" || userId.length === 0) reject("user_id_missing");
    if (
      !options.skipRequiredClaims &&
      !config.required_claims.every((requirement) => requirementMatches(payload, requirement))
    ) reject("claims_missing", userId);

    return { userId, payload };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    // `jose` enforces `exp` inside `jwtVerify`, so an expired token never
    // reaches the check above — its reason is read off the library's own error
    // code instead. Worth the one special case: "your session aged out" and
    // "this signature is wrong" are different incidents, and the checks above
    // stay as the answer if `jose` ever stops making that call for us.
    //
    // Everything else it throws for — a malformed token, an unsupported key —
    // shares the catch-all, where a signature that does not verify dominates.
    const code = (error as { code?: unknown }).code;
    return reject(code === "ERR_JWT_EXPIRED" ? "expired" : "bad_signature");
  }
}

export function clearJwksCache(): void {
  jwksCache.clear();
}
