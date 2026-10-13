/**
 * How an application's clients authenticate, read off its configuration once.
 *
 * Five configurations, three ways to authenticate: an API key alone, an API
 * key with the end user named in a header, or a gateway token minted by one of
 * two exchanges — an API key plus an issuer token, or an App Attest assertion
 * with the user taken from an issuer token or the installation itself.
 * {@link clientAuth} settles which once, into a {@link ClientAuth} whose fields
 * answer every question the client path asks — which header a credential may
 * arrive in, which headers the gateway consumes, how a credential is verified,
 * and which exchange `/auth/token` runs — so none of those callers re-derives
 * it from the raw union.
 */

import { lookupActiveApiKeyById, verifyApiKey } from "./api-keys";
import { GatewayError } from "../core/errors";
import { verifyGatewayToken } from "./gateway-token";
import { PROOF_HEADER, verifyRequestProof } from "./request-proof";
import { organizationProviders, type OrganizationProviders } from "../providers/provider-store";
import { providerDescriptor, type ProviderType } from "../shared/providers";
import {
  type AppleAppAttestAuthentication,
  type AuthenticationConfig,
  type IssuerAuthentication,
  PROVIDER_SLUG_PATTERN,
} from "../shared/app-config";
import { lookup } from "../shared/records";
import type { AppRecord, GatewayIdentity } from "../core/types";

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
  auth: ClientAuth,
  provider: ProviderType | undefined,
): RequestCredential {
  const candidates: string[] = ["authorization"];
  if (provider) candidates.push(providerDescriptor(provider).auth.header);
  if (auth.tokenHeader && !candidates.includes(auth.tokenHeader)) candidates.push(auth.tokenHeader);
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

/** The configuration each token exchange runs on. */
interface ExchangeConfigs {
  api_key_issuer: { issuer: IssuerAuthentication };
  app_attest: { authentication: AppleAppAttestAuthentication };
}

export type ExchangeType = keyof ExchangeConfigs;

/**
 * Which token exchange an application offers, with the configuration it runs
 * on: its API key plus a user's issuer token, or an App Attest assertion.
 *
 * Written as a map over {@link ExchangeType} so a function generic in the type
 * can hand one member to the handler for that same member.
 */
export type TokenExchange<K extends ExchangeType = ExchangeType> = {
  [P in K]: { type: P } & ExchangeConfigs[P];
}[K];

/** One application's way of authenticating its clients. */
export interface ClientAuth {
  /**
   * The exchange `/auth/token` runs, or null where the API key is presented
   * on every request and there is nothing to exchange.
   */
  readonly exchange: TokenExchange | null;
  /** The issuer token header, lowercased: one more place a client may send its credential. */
  readonly tokenHeader: string | undefined;
  /**
   * Headers the gateway reads for itself and so never forwards upstream: the
   * issuer token header and the end-user header, whatever they are called.
   * The header a credential arrived in is added per request.
   */
  readonly consumedHeaders: readonly string[];
  /**
   * Whether every request an attest gateway token is sent with must carry an
   * `X-AppAttest-Proof`: an App Attest application whose `verify_on` is
   * `every_request`. Where it is `token_exchange`, the assertion was verified
   * when the token was minted, and the token alone authenticates a request.
   */
  readonly verifiesEveryRequest: boolean;
  /**
   * The verification a request's credential needs, ready to start. Whatever
   * the request must name besides its credential is read before anything is
   * verified — a request that names no user is refused for that, not for its
   * credential — and the returned function is what the caller overlaps with
   * its other reads.
   */
  verifier(
    env: Env,
    appId: string,
    headers: Headers,
    credential: RequestCredential,
  ): () => Promise<GatewayIdentity>;
}

/**
 * The API key on every request. With no end-user header the key is the whole
 * identity, and a `null` user says so rather than standing in for a user that
 * does not exist.
 */
function apiKeyAuth(endUserHeader: string | null): ClientAuth {
  return {
    exchange: null,
    tokenHeader: undefined,
    verifiesEveryRequest: false,
    // A proof sent to a server application is ignored, and never forwarded.
    consumedHeaders: endUserHeader === null ? [PROOF_HEADER] : [endUserHeader, PROOF_HEADER],
    verifier(env, appId, headers, credential) {
      const userId = endUserHeader === null ? null : requiredEndUserId(headers, endUserHeader);
      return () => verifyApiKey(credential.token, env, appId, userId);
    },
  };
}

/**
 * A gateway token minted by the application's exchange on every request. One
 * minted from an API key names it, and is refused as soon as that key is
 * revoked rather than when the token expires.
 */
function gatewayTokenAuth(exchange: TokenExchange, issuer: IssuerAuthentication | undefined): ClientAuth {
  const tokenHeader = issuer?.token_header?.toLowerCase();
  // The proof a token minted by an exchange answers to: App Attest's, or the
  // API key it names.
  const authMethod = exchange.type === "app_attest" ? "attest" : "api_key";
  const verifiesEveryRequest = exchange.type === "app_attest"
    && exchange.authentication.app_attest.verify_on === "every_request";
  return {
    exchange,
    tokenHeader,
    verifiesEveryRequest,
    // Consumed in either mode: a proof sent where none is checked is ignored,
    // and never forwarded.
    consumedHeaders: tokenHeader === undefined ? [PROOF_HEADER] : [tokenHeader, PROOF_HEADER],
    verifier(env, appId, _headers, credential) {
      return async () => {
        const identity = await verifyGatewayToken(credential.token, env.JWT_SECRET, appId);
        // A token minted by the exchange this application used to run, before
        // its authentication changed, is not one it would mint now: an API-key
        // token on an App Attest application would skip App Attest altogether,
        // and an attest token on an API-key one would skip the key's revocation.
        if (identity.authMethod !== authMethod) {
          throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
        }
        if (identity.apiKeyId !== undefined) {
          const apiKey = await lookupActiveApiKeyById(env, identity.apiKeyId);
          if (!apiKey || apiKey.appId !== appId) {
            throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
          }
        }
        return identity;
      };
    },
  };
}

function resolveClientAuth(authentication: AuthenticationConfig): ClientAuth {
  if (authentication.type === "apple_app_attest") {
    const endUser = authentication.end_user;
    return gatewayTokenAuth(
      { type: "app_attest", authentication },
      endUser.source === "issuer" ? endUser.issuer : undefined,
    );
  }
  const endUser = authentication.end_user;
  switch (endUser.source) {
    case "none":
      return apiKeyAuth(null);
    case "header":
      return apiKeyAuth(endUser.header);
    case "issuer":
      return gatewayTokenAuth({ type: "api_key_issuer", issuer: endUser.issuer }, endUser.issuer);
  }
}

/** Keyed by the parsed block, which lives exactly as long as the cached app record holding it. */
const resolved = new WeakMap<AuthenticationConfig, ClientAuth>();

/** How this application's clients authenticate. */
export function clientAuth(app: AppRecord): ClientAuth {
  const { authentication } = app.config;
  let auth = resolved.get(authentication);
  if (!auth) {
    auth = resolveClientAuth(authentication);
    resolved.set(authentication, auth);
  }
  return auth;
}

/** What an authenticated request proved, beyond whose it is. */
export interface AuthenticatedRequest {
  identity: GatewayIdentity;
  credential: RequestCredential;
  /**
   * The counter of the App Attest assertion the request was signed with, for
   * the install's limiter to accept or refuse as a replay. Null where nothing
   * was signed: a server application, or an App Attest one that verifies on
   * the token exchange.
   */
  assertionCounter: number | null;
}

/**
 * Authenticates one client request against its application: which credential
 * it carried, whose identity that credential proves and, for an App Attest
 * application that verifies on every request, that the install's key signed
 * this very request.
 *
 * `providerSlug` is the proxied provider, where the route names one; it is read
 * only when `authorization` carried nothing, because that is when the provider
 * decides which native header to look in. `providers` is the organization's
 * provider rows when the caller has already started reading them: the header
 * choice reuses that read, and verification overlaps it, so the rows are
 * cached by the time the request is prepared. Its own failure is left to
 * whoever needs a provider — verification decides first, and a rejection here
 * is never the provider read's.
 *
 * `body` reads the request body, once: the caller shares the same bytes with
 * whatever prepares the request afterwards, so the proof is checked over
 * exactly what is forwarded from, before anything rewrites it.
 */
export async function authenticateRequest(input: {
  env: Env;
  app: AppRecord;
  request: Request;
  body: () => Promise<Uint8Array>;
  providerSlug?: string | undefined;
  providers?: Promise<OrganizationProviders> | undefined;
}): Promise<AuthenticatedRequest> {
  const { env, app, request } = input;
  const headers = request.headers;
  const auth = clientAuth(app);
  const credential = authorizationCredential(headers) ?? requestCredential(
    headers,
    auth,
    await providerTypeForHeader(env, app.organizationId, input.providerSlug, input.providers),
  );
  const verify = auth.verifier(env, app.id, headers, credential);
  const [verified] = await Promise.allSettled([verify(), input.providers ?? Promise.resolve()]);
  if (verified.status === "rejected") throw verified.reason;
  const identity = verified.value;
  // Only an attest token on an application that verifies every request is
  // signed per request; anything else proved itself with its credential
  // alone, and a proof header beside it is ignored: not verified, and its
  // counter never reaches the install's limiter.
  if (identity.authMethod !== "attest" || !auth.verifiesEveryRequest) {
    return { identity, credential, assertionCounter: null };
  }
  const header = headers.get(PROOF_HEADER);
  if (header === null) {
    throw new GatewayError(
      401,
      "assertion_required",
      "This app requires every request to be signed with App Attest. Update the AppAIGateway Swift package to 2.0 or later.",
    );
  }
  const assertionCounter = await verifyRequestProof({
    env,
    app,
    identity,
    header,
    method: request.method,
    url: request.url,
    body: await input.body(),
    token: credential.token,
  });
  return { identity, credential, assertionCounter };
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
