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

async function fetchJwks(url: string): Promise<JWK[]> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new GatewayError(403, "issuer_token_rejected", "Issuer keys could not be loaded");
  }
  if (!response.ok) {
    throw new GatewayError(403, "issuer_token_rejected", "Issuer keys could not be loaded");
  }
  const body = (await response.json()) as JSONWebKeySet;
  if (!Array.isArray(body.keys)) {
    throw new GatewayError(403, "issuer_token_rejected", "Issuer JWKS is invalid");
  }
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

function reject(): never {
  throw new GatewayError(403, "issuer_token_rejected", "Issuer token was rejected");
}

export async function verifyIssuerToken(
  token: string,
  config: IssuerAuthConfig,
  options: { skipRequiredClaims?: boolean } = {},
): Promise<{ userId: string; payload: JWTPayload }> {
  try {
    const header = decodeProtectedHeader(token);
    if (
      typeof header.kid !== "string" ||
      typeof header.alg !== "string" ||
      !ALLOWED_ISSUER_ALGORITHMS.has(header.alg)
    ) reject();

    let keys = await keysFor(config.jwks_url);
    let jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      keys = await fetchJwks(config.jwks_url);
      jwk = keys.find((candidate) => candidate.kid === header.kid);
    }
    if (!jwk) reject();
    if (jwk.alg !== undefined && jwk.alg !== header.alg) reject();

    const publicKey = await importJWK(jwk, header.alg);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [...ALLOWED_ISSUER_ALGORITHMS],
    });
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") reject();
    if (payload.exp <= Math.floor(Date.now() / 1000)) reject();
    if (payload.exp <= payload.iat || payload.exp - payload.iat > config.max_token_lifetime_seconds) reject();
    if (
      !options.skipRequiredClaims &&
      !config.required_claims.every((requirement) => requirementMatches(payload, requirement))
    ) reject();

    const userId = claimAtPath(payload, config.user_id_claim);
    if (typeof userId !== "string" || userId.length === 0) reject();
    return { userId, payload };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    return reject();
  }
}

export function clearJwksCache(): void {
  jwksCache.clear();
}
