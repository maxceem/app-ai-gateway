/**
 * How an app's clients authenticate, read from its settings once.
 *
 * Five configurations, three ways to authenticate: an app key alone, an app
 * key with the end user named in a header, or a gateway token from one of two
 * exchanges (an app key plus an issuer token, or an App Attest assertion with
 * the user taken from an issuer token or the install itself). `clientAuth`
 * settles which once per configuration, and `authenticateRequest` is what the
 * request path calls.
 */
import { lookupActiveApiKeyById, verifyApiKey } from "./api-keys.ts";
import { GatewayError } from "../core/errors.ts";
import { verifyGatewayToken } from "./gateway-token.ts";
import { PROOF_HEADER, verifyRequestProof } from "./request-proof.ts";
import { GATEWAY_IDENTITY_HEADERS } from "../contracts/app-config.ts";
import type {
  AppleAppAttestAuthentication,
  AuthenticationConfig,
  IssuerAuthentication,
} from "../contracts/app-config.ts";
import type { AppRecord, GatewayIdentity } from "../core/types.ts";

export interface RequestCredential {
  token: string;
  headerName: string;
}

function tokenFromHeader(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value.trim();
}

export function authorizationCredential(headers: Headers): RequestCredential | null {
  const token = tokenFromHeader(headers.get("authorization"));
  return token ? { token, headerName: "authorization" } : null;
}

/**
 * The credential, from `Authorization`, the provider's own key header (so an
 * official SDK pointed at the gateway works unchanged), or the app's issuer
 * token header. A provider key header is never read when it is a header the
 * gateway or this app reads identity or proof from: a value there is a user
 * id or a proof, and would otherwise be taken as the app key too.
 */
export function requestCredential(
  headers: Headers,
  auth: ClientAuth,
  providerAuthHeader: string | undefined,
): RequestCredential {
  const candidates: string[] = ["authorization"];
  const provider = providerAuthHeader?.toLowerCase();
  if (provider !== undefined && !candidates.includes(provider) && !GATEWAY_IDENTITY_HEADERS.has(provider) && !auth.identityHeaders.includes(provider)) {
    candidates.push(provider);
  }
  if (auth.tokenHeader !== undefined && !candidates.includes(auth.tokenHeader)) candidates.push(auth.tokenHeader);
  for (const name of candidates) {
    const token = tokenFromHeader(headers.get(name));
    if (token) return { token, headerName: name };
  }
  throw new GatewayError(401, "auth_required", "A gateway access token is required");
}

function requiredEndUserId(headers: Headers, header: string): string {
  const value = headers.get(header);
  if (value === null) throw new GatewayError(400, "invalid_request", `${header} is required`);
  if (!/^[\x21-\x7e]{1,128}$/u.test(value)) {
    throw new GatewayError(400, "invalid_request", `${header} must be 1-128 printable ASCII characters`);
  }
  return value;
}

interface ExchangeConfigs {
  api_key_issuer: { issuer: IssuerAuthentication };
  app_attest: { authentication: AppleAppAttestAuthentication };
}

export type ExchangeType = keyof ExchangeConfigs;

export type TokenExchange<K extends ExchangeType = ExchangeType> = {
  [P in K]: { type: P } & ExchangeConfigs[P];
}[K];

export interface ClientAuth {
  /** The exchange `/auth/token` runs, or null where clients send an app key on every request. */
  readonly exchange: TokenExchange | null;
  /** A header the app's issuer token may arrive in, besides `Authorization`. */
  readonly tokenHeader: string | undefined;
  /** Headers the gateway reads and does not pass to the provider. */
  readonly consumedHeaders: readonly string[];
  /** Headers this app's identity or proof is read from: never read as its app key. */
  readonly identityHeaders: readonly string[];
  /** Every request carries `X-AppAttest-Proof`. */
  readonly verifiesEveryRequest: boolean;
  verifier(env: Env, appId: string, headers: Headers, credential: RequestCredential): () => Promise<GatewayIdentity>;
}

function apiKeyAuth(endUserHeader: string | null): ClientAuth {
  return {
    exchange: null,
    tokenHeader: undefined,
    verifiesEveryRequest: false,
    consumedHeaders: endUserHeader === null ? [PROOF_HEADER] : [endUserHeader, PROOF_HEADER],
    identityHeaders: endUserHeader === null ? [PROOF_HEADER] : [endUserHeader.toLowerCase(), PROOF_HEADER],
    verifier(env, appId, headers, credential) {
      const userId = endUserHeader === null ? null : requiredEndUserId(headers, endUserHeader);
      return () => verifyApiKey(credential.token, env, appId, userId);
    },
  };
}

function gatewayTokenAuth(exchange: TokenExchange, issuer: IssuerAuthentication | undefined): ClientAuth {
  const tokenHeader = issuer?.token_header?.toLowerCase();
  const authMethod = exchange.type === "app_attest" ? "attest" : "api_key";
  const verifiesEveryRequest =
    exchange.type === "app_attest" && exchange.authentication.app_attest.verify_on === "every_request";
  return {
    exchange,
    tokenHeader,
    verifiesEveryRequest,
    consumedHeaders: tokenHeader === undefined ? [PROOF_HEADER] : [tokenHeader, PROOF_HEADER],
    identityHeaders: [PROOF_HEADER],
    verifier(env, appId, _headers, credential) {
      return async () => {
        const identity = await verifyGatewayToken(credential.token, env.JWT_SECRET, appId);
        // A token minted by the other exchange is refused, so changing an
        // app's sign-in type takes effect at once.
        if (identity.authMethod !== authMethod) {
          throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
        }
        // A token exchanged with an app key stops working when that key is revoked.
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
    return gatewayTokenAuth({ type: "app_attest", authentication }, endUser.source === "issuer" ? endUser.issuer : undefined);
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

const resolved = new WeakMap<AuthenticationConfig, ClientAuth>();

export function clientAuth(app: AppRecord): ClientAuth {
  let auth = resolved.get(app.authentication);
  if (!auth) {
    auth = resolveClientAuth(app.authentication);
    resolved.set(app.authentication, auth);
  }
  return auth;
}

export interface AuthenticatedRequest {
  identity: GatewayIdentity;
  credential: RequestCredential;
  /**
   * The counter of the request's App Attest assertion, when the app signs
   * every request. The caller must accept it once on the install's limiter
   * object (`useAssertionCounter`), or the request is a replay.
   */
  assertionCounter: number | null;
}

/**
 * Checks who is calling. Throws a `GatewayError` if the caller is not
 * verified, or if a check cannot finish: a request is never served unchecked.
 *
 * `body` is read only when the request carries an App Attest proof, which
 * signs the raw body.
 */
export async function authenticateRequest(input: {
  env: Env;
  app: AppRecord;
  request: Request;
  body: () => Promise<Uint8Array>;
  /** The provider description's key header, so a token sent there is found. */
  providerAuthHeader?: string;
}): Promise<AuthenticatedRequest> {
  const { env, app, request } = input;
  const headers = request.headers;
  const auth = clientAuth(app);
  const credential = authorizationCredential(headers) ?? requestCredential(headers, auth, input.providerAuthHeader);
  const identity = await auth.verifier(env, app.id, headers, credential)();
  if (identity.authMethod !== "attest" || !auth.verifiesEveryRequest) {
    return { identity, credential, assertionCounter: null };
  }
  const header = headers.get(PROOF_HEADER);
  if (header === null) {
    throw new GatewayError(
      401,
      "assertion_required",
      "This app requires every request to be signed with App Attest, in X-AppAttest-Proof.",
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
