/**
 * The per-request App Attest proof: every request an App Attest application's
 * gateway token is sent with carries an assertion the install's key signed
 * over that very request.
 *
 * The header is
 *
 *     X-AppAttest-Proof: v1.<timestamp>.<nonce>.<assertion>
 *
 * with the timestamp in decimal unix seconds, the nonce sixteen random bytes
 * and the assertion `DCAppAttestService.generateAssertion`'s CBOR, both
 * base64url without padding. What the device signs is the SHA-256 of the lines
 * {@link requestClientData} joins, so the assertion covers the application,
 * the method, the path and query exactly as sent, the body, the token, and
 * the moment. A token copied off the wire is worthless without the key, and a
 * proof copied with it is worthless for any other request — and, because the
 * install's limiter refuses a counter it has seen, for the same one again.
 */

import { and, eq } from "drizzle-orm";
import { GatewayError } from "../core/errors";
import { ttlCache } from "../core/ttl-cache";
import type { AppRecord, GatewayIdentity } from "../core/types";
import { database } from "../db";
import { appAttestKey, type AttestEnvironment } from "../db/schema";

/** The header a proof arrives in, lowercased as `Headers` reads it. */
export const PROOF_HEADER = "x-appattest-proof";

/** The first line of every client data string, which names this format and its version. */
export const REQUEST_PROOF_DOMAIN = "appaigateway-request-v1";

/** How far a device clock may be from the gateway's, either way. */
export const PROOF_MAX_SKEW_SECONDS = 300;

/** Far above any real assertion (a few hundred bytes), and well below a header's limit. */
const MAX_ASSERTION_LENGTH = 8192;

const encoder = new TextEncoder();

export interface ParsedProof {
  timestamp: number;
  /** As received: it is signed as text. */
  timestampText: string;
  nonce: string;
  assertion: string;
}

function malformed(): never {
  throw new GatewayError(403, "attest_failed", "X-AppAttest-Proof is malformed");
}

/** A proof header, or `attest_failed` naming it malformed. Checks shape only. */
export function parseProof(header: string): ParsedProof {
  const parts = header.trim().split(".");
  if (parts.length !== 4) malformed();
  const [version, timestampText, nonce, assertion] = parts as [string, string, string, string];
  if (version !== "v1") malformed();
  if (!/^[0-9]{1,12}$/u.test(timestampText)) malformed();
  // Sixteen bytes are twenty-two base64url characters without padding.
  if (!/^[A-Za-z0-9_-]{22}$/u.test(nonce)) malformed();
  if (assertion.length === 0 || assertion.length > MAX_ASSERTION_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(assertion)) {
    malformed();
  }
  return { timestamp: Number(timestampText), timestampText, nonce, assertion };
}

/** Base64url without padding, the encoding every hash in the client data uses. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
}

/**
 * The exact text a device signs for one request: these lines joined by `\n`,
 * with no trailing newline. The Swift package builds the same string; its
 * golden test and this module's pin the bytes on both sides.
 */
export async function requestClientData(input: {
  appId: string;
  method: string;
  /** The URL's path and query exactly as sent, e.g. `/v1/apps/a/proxy/openai/v1/responses?x=1`. */
  pathAndQuery: string;
  body: Uint8Array;
  token: string;
  timestamp: string;
  nonce: string;
}): Promise<string> {
  return [
    REQUEST_PROOF_DOMAIN,
    input.appId,
    input.method.toUpperCase(),
    input.pathAndQuery,
    base64url(await sha256(input.body)),
    base64url(await sha256(encoder.encode(input.token))),
    input.timestamp,
    input.nonce,
  ].join("\n");
}

/** One registered key as a proof is checked against it. */
interface RegisteredKey {
  publicKey: string;
  environment: AttestEnvironment;
}

/**
 * Registered keys by `(app, key id)`, as pending reads so concurrent requests
 * of one install share one. A minute is how long a deleted key could still be
 * read here; an environment an application withdraws is checked against the
 * application's own configuration on every request, so it is not.
 */
const keyCache = ttlCache<string, Promise<RegisteredKey | null>>({
  name: "app-attest-key",
  ttlMs: 60_000,
  maxEntries: 50_000,
});

const keyCacheKey = (appId: string, keyId: string): string => JSON.stringify([appId, keyId]);

/** Forgets one key in this isolate, for the registration that just replaced it. */
export function invalidateRegisteredKey(appId: string, keyId: string): void {
  keyCache.delete(keyCacheKey(appId, keyId));
}

function registeredKey(env: Env, appId: string, keyId: string): Promise<RegisteredKey | null> {
  const cacheKey = keyCacheKey(appId, keyId);
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = database(env.DB).query.appAttestKey.findFirst({
    columns: { publicKey: true, environment: true },
    where: and(eq(appAttestKey.appId, appId), eq(appAttestKey.keyId, keyId)),
  }).then((row) => row ?? null);
  keyCache.set(cacheKey, pending);
  void pending.catch(() => {
    if (keyCache.peek(cacheKey)?.value === pending) keyCache.delete(cacheKey);
  });
  return pending;
}

/**
 * Verifies one request's proof against the install its token names, and
 * answers the assertion's counter for the install's limiter to judge.
 *
 * In the order that costs least for what it refuses: the header's shape, its
 * clock, the key and its environment, and only then the signature.
 */
export async function verifyRequestProof(input: {
  env: Env;
  app: AppRecord;
  identity: GatewayIdentity;
  header: string;
  method: string;
  url: string;
  body: Uint8Array;
  token: string;
  now?: number;
}): Promise<number> {
  const { app, identity } = input;
  const authentication = app.config.authentication;
  if (authentication.type !== "apple_app_attest" || identity.installId === null) {
    throw new GatewayError(403, "attest_failed", "This application does not sign requests with App Attest");
  }
  const proof = parseProof(input.header);
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - proof.timestamp) > PROOF_MAX_SKEW_SECONDS) {
    throw new GatewayError(403, "attest_failed", "App Attest request proof is stale; check the device clock");
  }
  const key = await registeredKey(input.env, app.id, identity.installId);
  if (!key) throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
  // An assertion carries no aaguid, so the environment recorded at
  // registration is the only record of it; withdrawing one stops its keys on
  // their next request.
  if (!authentication.app_attest.environments.includes(key.environment)) {
    throw new GatewayError(403, "attest_failed", "The registered App Attest environment is no longer allowed");
  }
  // The path and query as the runtime's WHATWG parser left them, which is
  // also the form the Swift package normalizes its URL to before signing; the
  // shared fixtures in app-ai-gateway-swift/Tests pin the two together.
  const url = new URL(input.url);
  const clientData = await requestClientData({
    appId: app.id,
    method: input.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    body: input.body,
    token: input.token,
    timestamp: proof.timestampText,
    nonce: proof.nonce,
  });
  const { verifyAppAssertion } = await import("./app-assertion");
  return verifyAppAssertion({
    rpId: `${authentication.app_attest.team_id}.${authentication.app_attest.bundle_id}`,
    assertion: proof.assertion,
    publicKeyPem: key.publicKey,
    clientDataHash: await sha256(encoder.encode(clientData)),
  });
}
