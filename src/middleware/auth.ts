import type { MiddlewareHandler } from "hono";
import { assertAppActive, endUserHeader, endUserIssuer, loadApp } from "../core/config";
import { lookupActiveApiKeyById, verifyApiKey } from "../core/apikeys";
import { GatewayError } from "../core/errors";
import { verifyGatewayToken } from "../core/jwt";
import { organizationProviders, type OrganizationProviders } from "../core/provider-store";
import { providerDescriptor, PROVIDER_SLUG_PATTERN } from "../core/providers";
import { lookup } from "../shared/records";
import type { AppRecord, GatewayIdentity, ProviderType } from "../core/types";
import type { RequestVariables } from "./request-scope";

export interface GatewayVariables extends RequestVariables {
  app: AppRecord;
  identity: GatewayIdentity;
  authHeaderName: string;
  authDurationMs: number;
  limiterDurationMs: number;
}

function tokenFromHeader(value: string | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value.trim();
}

/**
 * The gateway token as `authorization` carries it, or `null` when that header
 * is absent or empty.
 *
 * Split out of {@link extractGatewayToken} because `authorization` is the first
 * candidate it tries and the only one whose name does not depend on which
 * provider the request is for. Whenever it answers, the provider rows have no
 * say in the choice, so the request does not have to wait for them — and when
 * it does not answer, the header falls through to the provider-native one
 * exactly as it would inside `extractGatewayToken`, including the case of a
 * header that is present but empty.
 */
function authorizationToken(headers: Headers): { token: string; headerName: string } | null {
  const token = tokenFromHeader(headers.get("authorization") ?? undefined);
  return token ? { token, headerName: "authorization" } : null;
}

export function extractGatewayToken(
  headers: Headers,
  provider: ProviderType | undefined,
  customHeader: string | undefined,
): { token: string; headerName: string } {
  const candidates: string[] = ["authorization"];
  if (provider) candidates.push(providerDescriptor(provider).auth.header);
  if (customHeader && !candidates.includes(customHeader.toLowerCase())) candidates.push(customHeader.toLowerCase());
  for (const name of candidates) {
    const token = tokenFromHeader(headers.get(name) ?? undefined);
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
 * The provider type behind the `:provider` slug, or `undefined` when the route
 * has no such param or the slug could never be one. Only reached when
 * `authorization` carried nothing, so this is the one case that has to wait for
 * the provider rows before it can name the header to read.
 */
async function providerTypeForHeader(
  env: Env,
  organizationId: string,
  rawProvider: string | undefined,
  warm: Promise<OrganizationProviders> | undefined,
): Promise<ProviderType | undefined> {
  if (typeof rawProvider !== "string" || !PROVIDER_SLUG_PATTERN.test(rawProvider)) return undefined;
  return lookup(await (warm ?? organizationProviders(env, organizationId)), rawProvider)?.type;
}

export const gatewayAuth: MiddlewareHandler<{ Bindings: Env; Variables: GatewayVariables }> = async (c, next) => {
  const start = performance.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  /*
   * The organization's provider rows, started here and awaited as late as the
   * request lets us.
   *
   * Every served request needs them: the proxy resolves the instance it will
   * call, and an endpoint resolves one per target. Starting the read now means
   * it overlaps the key lookup below instead of following it, which on a cold
   * isolate is one cross-region round trip saved rather than two paid in turn.
   * It is started on every served path, not only where a `:provider` param
   * names one, so an endpoint request warms the same cache `endpointPrepare`
   * is about to read.
   *
   * A failure here belongs to whoever actually needs a provider. Nothing in
   * this middleware reads the value except the header choice below, and both
   * `proxyPrepare` and `endpointPrepare` re-read the same cache and report the
   * failure against the instance they were asked for. The sink keeps a
   * rejection nobody awaits — the request may still be refused for a missing
   * credential or a bad key first — from surfacing as an unhandled rejection.
   */
  const providersWarm = c.req.path.includes("/proxy/") || c.req.path.includes("/endpoints/")
    ? organizationProviders(c.env, app.organizationId)
    : undefined;
  providersWarm?.catch(() => {});
  /*
   * `authorization` is tried first, and when it carries a token the provider
   * type cannot change which header was chosen, so the credential is settled
   * without waiting for the rows above. Only a request that leaves
   * `authorization` empty has to know the provider first, because that is what
   * names the provider-native header the SDKs send instead.
   */
  const credential = authorizationToken(c.req.raw.headers) ?? extractGatewayToken(
    c.req.raw.headers,
    await providerTypeForHeader(
      c.env,
      app.organizationId,
      c.req.param("provider"),
      providersWarm,
    ),
    endUserIssuer(app.config.authentication)?.token_header,
  );
  /*
   * How the client proved itself and who it acts for are two different
   * questions, so they are answered separately. The credential above settles the
   * first; `end_user` settles the second, and only a header-sourced identity is
   * read from the request at all — an issuer-sourced or app-install one was
   * settled when the gateway token was minted, and is carried in its subject.
   */
  const header = endUserHeader(app.config.authentication);
  let verify: () => Promise<GatewayIdentity>;
  if (header !== undefined) {
    // Read before the verification starts, as it always has been: a request
    // that names no user is refused for that, not for its credential.
    const userId = requiredEndUserId(c.req.raw.headers, header);
    verify = () => verifyApiKey(credential.token, c.env, appId, userId);
  } else if (app.config.authentication.type === "api_key" && app.config.authentication.end_user === undefined) {
    // No end users: the key is the whole identity, and `null` says so rather
    // than standing in for a user that does not exist.
    verify = () => verifyApiKey(credential.token, c.env, appId, null);
  } else {
    verify = async () => {
      const identity = await verifyGatewayToken(credential.token, c.env.JWT_SECRET, appId);
      if (identity.apiKeyId !== undefined) {
        const apiKey = await lookupActiveApiKeyById(c.env, identity.apiKeyId);
        if (!apiKey || apiKey.appId !== appId) {
          throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
        }
      }
      return identity;
    };
  }
  /*
   * The two independent reads of this middleware, run together: whichever of
   * the key lookups the identity needs, and the provider rows started above.
   *
   * `allSettled` because the identity is what decides. Its rejection is thrown
   * first and unchanged, so every refusal this middleware could make before
   * still comes out in the same order; and a provider read that fails while an
   * `auth_required` is on its way out must not also become an unhandled
   * rejection. The warm outcome is ignored for the same reason as in the
   * billing gate — it is a cache fill, and its real reader re-reads it.
   *
   * It is awaited rather than left running so that the cache is filled before
   * `proxyPrepare` looks: a request that ran ahead of it would start a second
   * identical read against the same rows.
   */
  const [verified] = await Promise.allSettled([verify(), providersWarm ?? Promise.resolve()]);
  if (verified.status === "rejected") throw verified.reason;
  const identity = verified.value;
  c.set("app", app);
  c.set("identity", identity);
  c.set("authHeaderName", credential.headerName);
  c.set("authDurationMs", performance.now() - start);
  await next();
};
