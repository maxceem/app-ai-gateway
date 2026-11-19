/**
 * The OAuth server for the CLI and MCP clients, on the console's host: the
 * discovery documents, and the authorization, token, revocation and device
 * authorization endpoints. The issuer is the console origin plus `/v2`, so:
 *
 * - `GET /.well-known/oauth-authorization-server/v2`
 * - `GET /.well-known/oauth-protected-resource/v2` (and `/v2/mcp`)
 * - `GET /v2/oauth/authorize`, `POST /v2/oauth/token`, `POST /v2/oauth/revoke`,
 *   `POST /v2/oauth/device_authorization`
 *
 * cf-auth decides every one of them. What is here is the HTTP around it: the
 * host, the browser origin, statuses, headers, the flood limits and the
 * authorization endpoint's error page (v1's, ported). On any other host, or
 * where the deployment runs no OAuth, these answer 404.
 */
import type { CfAuth, CfAuthOAuth } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { CONSENT_PAGE_PATH, identityFor } from "../auth/identity.ts";
import { allowedBrowserOrigins, consoleOrigin, V2_PATH } from "../auth/settings.ts";
import { clientAddress, enforceEndpointRateLimit } from "../core/flood-limit.ts";
import { GatewayError } from "../core/errors.ts";

type OAuthEnv = { Bindings: Env; Variables: { identity: Promise<CfAuth> } };
type OAuthContext = Context<OAuthEnv>;

export const oauthRoutes = new Hono<OAuthEnv>();

/** Every path this module serves, as cf-auth's `routePaths()` names them for a `/v2` issuer. */
export const OAUTH_PATHS = {
  authorizationServerMetadata: `/.well-known/oauth-authorization-server${V2_PATH}`,
  protectedResourceMetadata: [
    { resourcePath: "", path: `/.well-known/oauth-protected-resource${V2_PATH}` },
    { resourcePath: "/mcp", path: `/.well-known/oauth-protected-resource${V2_PATH}/mcp` },
  ],
  authorize: `${V2_PATH}/oauth/authorize`,
  token: `${V2_PATH}/oauth/token`,
  revoke: `${V2_PATH}/oauth/revoke`,
  deviceAuthorization: `${V2_PATH}/oauth/device_authorization`,
} as const;

/** The largest form body the token, revocation or device endpoint reads. Real ones are a few hundred bytes. */
const MAX_FORM_BYTES = 16 * 1024;

const NOT_FOUND = { error: { code: "not_found", message: "Nothing is served at this path." } };

/** The OAuth service, or null on another host than the console's or where none runs. */
async function oauthFor(c: OAuthContext): Promise<CfAuthOAuth | null> {
  const origin = consoleOrigin(c.env);
  if (origin === null || new URL(c.req.url).host !== new URL(origin).host) return null;
  const identity = await identityFor(c);
  return identity.config.oauth === null ? null : identity.oauth;
}

// ---------------------------------------------------------------------------
// Discovery: public, cacheable, readable from any origin.

const DISCOVERY_HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } as const;

function discovery(read: (oauth: CfAuthOAuth) => unknown) {
  return async (c: OAuthContext) => {
    const oauth = await oauthFor(c);
    if (oauth === null) return c.json(NOT_FOUND, 404);
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    return c.json(read(oauth), 200, DISCOVERY_HEADERS);
  };
}

oauthRoutes.on(["GET", "OPTIONS"], OAUTH_PATHS.authorizationServerMetadata, discovery((oauth) => oauth.authorizationServerMetadata()));
for (const { resourcePath, path } of OAUTH_PATHS.protectedResourceMetadata) {
  oauthRoutes.on(["GET", "OPTIONS"], path, discovery((oauth) => oauth.protectedResourceMetadata(resourcePath)));
}

// ---------------------------------------------------------------------------
// The endpoints a client calls.

/**
 * A browser origin may call these only when it is the console's own, or one
 * `MCP_ALLOWED_ORIGINS` lists (answered with CORS, refusals included). A
 * request with no `Origin` is a CLI or a server, and is allowed.
 */
function withOrigin(handler: (c: OAuthContext, oauth: CfAuthOAuth) => Promise<Response>) {
  return async (c: OAuthContext) => {
    const oauth = await oauthFor(c);
    if (oauth === null) return c.json(NOT_FOUND, 404);
    const origin = c.req.header("origin") ?? "";
    let cors: Record<string, string> | null = null;
    if (origin !== "" && origin !== consoleOrigin(c.env)) {
      if (!allowedBrowserOrigins(c.env).includes(origin)) {
        return c.json({ error: "invalid_request", error_description: "This origin may not call this endpoint" }, 403, {
          "Cache-Control": "no-store",
        });
      }
      cors = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
        "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After",
        Vary: "Origin",
      };
    }
    const answer = c.req.method === "OPTIONS" ? new Response(null, { status: 204 }) : await handler(c, oauth);
    if (cors === null) return answer;
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };
}

const AUTHORIZE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const TOKEN_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/**
 * `GET /v2/oauth/authorize`. Counted per network address before cf-auth reads
 * it, since a request naming a metadata document makes it fetch one. The
 * consent page gets the browser proof in the fragment, so it never reaches a log.
 */
oauthRoutes.on(["GET", "OPTIONS"], OAUTH_PATHS.authorize, withOrigin(async (c, oauth) => {
  const address = clientAddress(c.req.raw);
  try {
    await enforceEndpointRateLimit(c.env, "oauth_authorize", address);
  } catch (error) {
    if (!(error instanceof GatewayError) || error.status !== 429) throw error;
    return errorPage(429, "too_many_requests", error.message, new Headers(error.headers));
  }
  const result = await oauth.authorize({ query: new URL(c.req.url).searchParams, rateLimitKey: address });
  if ("consent" in result) {
    const { id, proof } = result.consent;
    return new Response(null, {
      status: 302,
      headers: { ...AUTHORIZE_HEADERS, Location: `${CONSENT_PAGE_PATH}?id=${encodeURIComponent(id)}#${proof}` },
    });
  }
  if ("redirect" in result) return new Response(null, { status: 302, headers: { ...AUTHORIZE_HEADERS, Location: result.redirect } });
  return errorPage(result.error.status, result.error.code, result.error.description);
}));

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * The page the authorization endpoint answers when it must not send the
 * browser back to the client: no script, nothing external, never framed,
 * every value escaped.
 */
function errorPage(status: number, code: string, description: string, extra?: Headers): Response {
  const headers = new Headers({
    ...AUTHORIZE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  extra?.forEach((value, name) => headers.set(name, value));
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This connection cannot continue</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#18181b}
h1{font-size:1.25rem;margin:0 0 .75rem}
code{font-size:.85rem;background:#f4f4f5;padding:.1rem .35rem;border-radius:.25rem}
p{margin:.5rem 0}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}code{background:#27272a}}
</style>
</head>
<body>
<h1>This connection cannot continue</h1>
<p>${escapeHtml(description)}</p>
<p><code>${escapeHtml(code)}</code></p>
<p>Close this tab and start the connection again from your app. Nothing was sent back to it.</p>
</body>
</html>
`;
  return new Response(body, { status, headers });
}

/**
 * A form body: form-encoded only (RFC 6749), and never more than
 * {@link MAX_FORM_BYTES} read. A larger declared length is refused before
 * reading; a body without one is cancelled the moment it passes the limit.
 */
async function formBody(c: OAuthContext): Promise<URLSearchParams | Response> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return tokenError(400, "The body must be application/x-www-form-urlencoded");
  const declared = c.req.header("content-length");
  if (declared !== undefined && !(Number(declared) <= MAX_FORM_BYTES)) return tooLarge();
  const reader = c.req.raw.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

function tokenError(status: 400 | 413, description: string): Response {
  return Response.json({ error: "invalid_request", error_description: description }, { status, headers: TOKEN_HEADERS });
}

function tooLarge(): Response {
  return tokenError(413, `The body must be at most ${MAX_FORM_BYTES} bytes`);
}

/**
 * `POST /v2/oauth/token`: the code exchange, the refresh, and the device
 * grant's polls. A refresh presented again too soon is `429 slow_down` with
 * `Retry-After`.
 */
oauthRoutes.on(["POST", "OPTIONS"], OAUTH_PATHS.token, withOrigin(async (c, oauth) => {
  const body = await formBody(c);
  if (body instanceof Response) return body;
  const result = await oauth.token({ body });
  const headers = result.status === 429 ? { ...TOKEN_HEADERS, "Retry-After": String(result.retryAfterSeconds) } : TOKEN_HEADERS;
  return Response.json(result.body, { status: result.status, headers });
}));

/** `POST /v2/oauth/revoke` (RFC 7009): either token ends the whole connection. `agw logout` calls it. */
oauthRoutes.on(["POST", "OPTIONS"], OAUTH_PATHS.revoke, withOrigin(async (c, oauth) => {
  const body = await formBody(c);
  if (body instanceof Response) return body;
  const { status, body: answer } = await oauth.revoke({ body });
  return answer === null ? new Response(null, { status, headers: TOKEN_HEADERS }) : Response.json(answer, { status, headers: TOKEN_HEADERS });
}));

/**
 * `POST /v2/oauth/device_authorization` (RFC 8628): a CLI with no browser
 * asks for a code to show. Counted per network address first.
 */
oauthRoutes.on(["POST", "OPTIONS"], OAUTH_PATHS.deviceAuthorization, withOrigin(async (c, oauth) => {
  const address = clientAddress(c.req.raw);
  try {
    await enforceEndpointRateLimit(c.env, "device_authorization", address);
  } catch (error) {
    if (!(error instanceof GatewayError) || error.status !== 429) throw error;
    const headers = new Headers(error.headers);
    for (const [name, value] of Object.entries(TOKEN_HEADERS)) headers.set(name, value);
    return Response.json({ error: "slow_down", error_description: error.message }, { status: 429, headers });
  }
  const body = await formBody(c);
  if (body instanceof Response) return body;
  const result = await oauth.deviceAuthorization({ body, rateLimitKey: address });
  return Response.json(result.body, { status: result.status, headers: TOKEN_HEADERS });
}));
