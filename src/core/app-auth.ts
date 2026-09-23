/**
 * How an application's clients authenticate, read off its configuration once.
 *
 * Two questions, answered separately because the configuration answers them
 * separately: how the client proves itself — its API key on every request, or a
 * gateway token it exchanged for one — and who the request acts for, which is
 * nobody, a user id its backend names in a header, or the subject a gateway
 * token was minted for. Everything that asks either question on the client
 * path — the served request, `/me`, the token exchange and the header
 * sanitizer — asks it here, so none of them re-derives it from the raw union.
 */

import { lookupActiveApiKeyById, verifyApiKey } from "./apikeys";
import { endUserHeader, endUserIssuer } from "./config";
import { GatewayError } from "./errors";
import { verifyGatewayToken } from "./jwt";
import { organizationProviders, type OrganizationProviders } from "./provider-store";
import { providerDescriptor, PROVIDER_SLUG_PATTERN } from "./providers";
import { lookup } from "../shared/records";
import type { AppRecord, AuthenticationConfig, GatewayIdentity, ProviderType } from "./types";

/** A credential as the request carried it, and the header it came in. */
export interface RequestCredential {
  token: string;
  headerName: string;
}

function tokenFromHeader(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value.trim();
}

/**
 * The credential in `authorization`, or `null` when that header is absent or
 * empty. Split out because it is the first candidate and the only one whose
 * name does not depend on the provider: whenever it answers, the request does
 * not have to wait for the provider rows to know which header to read.
 */
export function authorizationCredential(headers: Headers): RequestCredential | null {
  const token = tokenFromHeader(headers.get("authorization"));
  return token ? { token, headerName: "authorization" } : null;
}

/**
 * The credential wherever a client may send it: `authorization`, then the
 * provider-native header the provider's own SDK sends its key in, then the
 * header an issuer-backed application names for its token.
 */
export function requestCredential(
  headers: Headers,
  authentication: AuthenticationConfig,
  provider: ProviderType | undefined,
): RequestCredential {
  const candidates: string[] = ["authorization"];
  if (provider) candidates.push(providerDescriptor(provider).auth.header);
  const custom = endUserIssuer(authentication)?.token_header;
  if (custom && !candidates.includes(custom.toLowerCase())) candidates.push(custom.toLowerCase());
  for (const name of candidates) {
    const token = tokenFromHeader(headers.get(name));
    if (token) return { token, headerName: name };
  }
  throw new GatewayError(401, "auth_required", "A gateway access token is required");
}

/**
 * The end-user id an application asked its backend to send. Required whenever a
 * header source is configured: choosing one is the operator saying this
 * application has users, and accepting a request without one would file that
 * traffic under nobody while per-user limits and blocks quietly stopped
 * applying to it.
 */
function requiredEndUserId(headers: Headers, header: string): string {
  const value = headers.get(header);
  if (value === null) {
    throw new GatewayError(400, "invalid_request", `${header} is required`);
  }
  if (!/^[\x21-\x7e]{1,128}$/u.test(value)) {
    throw new GatewayError(
      400,
      "invalid_request",
      `${header} must be 1-128 printable ASCII characters`,
    );
  }
  return value;
}

/**
 * The verification a request's credential needs, ready to start.
 *
 * A header-sourced end user is read before anything is verified, as it always
 * has been: a request that names no user is refused for that, not for its
 * credential. The returned function is what the caller overlaps with its other
 * reads.
 */
export function credentialVerifier(
  env: Env,
  app: AppRecord,
  headers: Headers,
  credential: RequestCredential,
): () => Promise<GatewayIdentity> {
  const { authentication } = app.config;
  const header = endUserHeader(authentication);
  if (header !== undefined) {
    const userId = requiredEndUserId(headers, header);
    return () => verifyApiKey(credential.token, env, app.id, userId);
  }
  if (authentication.type === "api_key" && authentication.end_user === undefined) {
    // No end users: the key is the whole identity, and `null` says so rather
    // than standing in for a user that does not exist.
    return () => verifyApiKey(credential.token, env, app.id, null);
  }
  // Everything else authenticates with a gateway token minted by the exchange.
  return async () => {
    const identity = await verifyGatewayToken(credential.token, env.JWT_SECRET, app.id);
    if (identity.apiKeyId !== undefined) {
      const apiKey = await lookupActiveApiKeyById(env, identity.apiKeyId);
      if (!apiKey || apiKey.appId !== app.id) {
        throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
      }
    }
    return identity;
  };
}

/**
 * Authenticates one client request against its application: which credential
 * it carried, and whose identity that credential proves.
 *
 * `providerSlug` is the proxied provider, where the route names one; it is read
 * only when `authorization` carried nothing, because that is when the provider
 * decides which native header to look in. `providers` is the organization's
 * provider rows when the caller has already started reading them: the header
 * choice reuses that read, and verification overlaps it, so the rows are
 * cached by the time the request is prepared. Its own failure is left to
 * whoever needs a provider — verification decides first, and a rejection here
 * is never the provider read's.
 */
export async function authenticateRequest(input: {
  env: Env;
  app: AppRecord;
  headers: Headers;
  providerSlug?: string | undefined;
  providers?: Promise<OrganizationProviders> | undefined;
}): Promise<{ identity: GatewayIdentity; credential: RequestCredential }> {
  const { env, app, headers } = input;
  const credential = authorizationCredential(headers) ?? requestCredential(
    headers,
    app.config.authentication,
    await providerTypeForHeader(env, app.organizationId, input.providerSlug, input.providers),
  );
  const verify = credentialVerifier(env, app, headers, credential);
  const [verified] = await Promise.allSettled([verify(), input.providers ?? Promise.resolve()]);
  if (verified.status === "rejected") throw verified.reason;
  return { identity: verified.value, credential };
}

/**
 * The provider type behind a `:provider` slug, or `undefined` when the route
 * names none or the slug could never be one.
 */
async function providerTypeForHeader(
  env: Env,
  organizationId: string,
  slug: string | undefined,
  providers: Promise<OrganizationProviders> | undefined,
): Promise<ProviderType | undefined> {
  if (slug === undefined || !PROVIDER_SLUG_PATTERN.test(slug)) return undefined;
  return lookup(await (providers ?? organizationProviders(env, organizationId)), slug)?.type;
}

/**
 * Headers the gateway consumes on a request and so never forwards upstream:
 * the one the credential arrived in, the issuer token header, and the header an
 * application reads its end-user id from, whatever it is called.
 */
export function consumedRequestHeaders(
  authentication: AuthenticationConfig,
  credentialHeader: string,
): string[] {
  return [
    endUserIssuer(authentication)?.token_header,
    endUserHeader(authentication),
    credentialHeader,
  ].filter((name): name is string => name !== undefined);
}

/**
 * Which token exchange an application offers, if any: its API key plus a
 * user's issuer token, or an App Attest assertion. An API-key application with
 * no issuer has nothing to exchange — its key is presented on every request.
 */
export type TokenExchange = "api_key_issuer" | "app_attest" | null;

export function tokenExchange(authentication: AuthenticationConfig): TokenExchange {
  if (authentication.type === "apple_app_attest") return "app_attest";
  return endUserIssuer(authentication) ? "api_key_issuer" : null;
}
