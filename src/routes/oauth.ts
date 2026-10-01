import type { CfAuthOAuth } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { identityAuthFor, MANAGEMENT_IDENTITY } from "../auth/identity";
import { clientAddress, enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError, ROUTE_NOT_FOUND } from "../core/errors";
import { consoleHost, originDecision, type OriginDecision } from "../mcp/origin";
import type { RequestVariables } from "../middleware/request-scope";

/**
 * OAuth for MCP clients, on the console host: the discovery documents, the
 * authorization endpoint and the token and revocation endpoints.
 *
 * cf-auth decides every one of these — whether a request is valid and for
 * which client, what a token exchange or a refresh answers — and mounts
 * nothing; what is here is the HTTP around it: the host, the browser origin,
 * the statuses, the headers and the authorization endpoint's error page. None
 * of them is a management operation, so none has a catalog entry; the MCP
 * guide documents the URLs. The consent page's API is in `./console`.
 *
 * Mounted inside the lazily loaded management app, so none of it is evaluated
 * by a proxied request.
 */
type OAuthEnv = { Bindings: Env; Variables: RequestVariables };
type OAuthContext = Context<OAuthEnv>;

export const oauthRoutes = new Hono<OAuthEnv>();

/** Where the authorization server publishes each endpoint; cf-auth's document names exactly these. */
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

/** The largest form body the token or revocation endpoint reads. Real ones are a few hundred bytes. */
const MAX_FORM_BYTES = 16 * 1024;

/**
 * The OAuth service, or null where this request may not reach it: another
 * host than the console's, which publishes no authorization server, or a
 * deployment that runs none.
 */
async function oauthFor(c: OAuthContext): Promise<CfAuthOAuth | null> {
  if (!consoleHost(c.req.raw, c.get("deployment"))) return null;
  const identity = await identityAuthFor(c, MANAGEMENT_IDENTITY);
  return identity.config.oauth === null ? null : identity.oauth;
}

// ---------------------------------------------------------------------------
// Discovery: public, cacheable, readable from any origin.
// ---------------------------------------------------------------------------

const DISCOVERY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=3600",
} as const;

/** A preflight for a discovery document: a client may send `MCP-Protocol-Version`, which needs one. */
function discoveryPreflight(): Response {
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

function discovery(read: (oauth: CfAuthOAuth) => unknown) {
  return async (c: OAuthContext) => {
    const oauth = await oauthFor(c);
    if (oauth === null) return c.json(ROUTE_NOT_FOUND, 404);
    if (c.req.method === "OPTIONS") return discoveryPreflight();
    return c.json(read(oauth), 200, DISCOVERY_HEADERS);
  };
}

for (const [path, read] of [
  [PROTECTED_RESOURCE, (oauth: CfAuthOAuth) => oauth.protectedResourceMetadata("")],
  [`${PROTECTED_RESOURCE}/mcp`, (oauth: CfAuthOAuth) => oauth.protectedResourceMetadata("/mcp")],
  ["/.well-known/oauth-authorization-server", (oauth: CfAuthOAuth) => oauth.authorizationServerMetadata()],
] as const) {
  oauthRoutes.on(["GET", "OPTIONS"], path, discovery(read));
}

// ---------------------------------------------------------------------------
// The endpoints a client calls: the MCP origin policy, with preflight.
// ---------------------------------------------------------------------------

/**
 * The browser origin rule the MCP endpoint keeps: none, the console's own, or
 * one `MCP_ALLOWED_ORIGINS` lists, which is answered with CORS on every
 * response, refusals included, and a preflight. Anything else is refused
 * before cf-auth is asked anything.
 */
function withOrigin(handler: (c: OAuthContext, oauth: CfAuthOAuth) => Promise<Response>) {
  return async (c: OAuthContext) => {
    const oauth = await oauthFor(c);
    if (oauth === null) return c.json(ROUTE_NOT_FOUND, 404);
    const origin: OriginDecision = originDecision(c.req.header("origin") ?? null, c.get("deployment"), "oauth");
    if (!origin.allowed) {
      return c.json({ error: "invalid_request", error_description: "This origin may not call this endpoint" }, 403, {
        "Cache-Control": "no-store",
      });
    }
    const answer = c.req.method === "OPTIONS" ? new Response(null, { status: 204 }) : await handler(c, oauth);
    if (origin.cors === null) return answer;
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(origin.cors)) response.headers.set(name, value);
    return response;
  };
}

/** What every answer of the authorization endpoint carries: never cached, never framed, no referrer. */
const AUTHORIZE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * `GET /oauth/authorize`. Counted per network address before cf-auth reads
 * the request, since a request naming a metadata document makes it fetch one;
 * then cf-auth answers one of three things: the consent page, with the
 * browser proof in the fragment so it never reaches a log; an error redirect
 * to the client; or an error page shown here, because the client or its
 * redirect URI cannot be trusted with one.
 */
oauthRoutes.on(["GET", "OPTIONS"], "/oauth/authorize", withOrigin(async (c, oauth) => {
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
      headers: { ...AUTHORIZE_HEADERS, Location: `/oauth/consent?id=${encodeURIComponent(id)}#${proof}` },
    });
  }
  if ("redirect" in result) {
    return new Response(null, { status: 302, headers: { ...AUTHORIZE_HEADERS, Location: result.redirect } });
  }
  return errorPage(result.error.status, result.error.code, result.error.description);
}));

/** Escapes text for an HTML text node or a double-quoted attribute. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * The page the authorization endpoint answers when it must not send the
 * browser back to the client. Self-contained — no script, no external
 * resource, never framed — and every value in it escaped, since cf-auth's
 * description may name what the request carried.
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

/** What every token and revocation answer carries: never cached (RFC 6749 §5.1). */
const TOKEN_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

/**
 * The form body of a token or revocation request: form-encoded only, as RFC
 * 6749 requires, and never more than {@link MAX_FORM_BYTES} bytes read. A
 * declared length over it is refused before anything is read; a body without
 * one is read as a byte stream and cancelled the moment it passes the limit,
 * so an unauthenticated caller cannot make the Worker buffer an arbitrary
 * body. Counted in bytes, before the text is decoded.
 */
async function formBody(c: OAuthContext): Promise<URLSearchParams | Response> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return tokenError(400, "The body must be application/x-www-form-urlencoded");
  }
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
    // Whichever way reading ended — the whole body, the limit, or a failed
    // read — the stream is not left locked to this reader.
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
  return Response.json(
    { error: "invalid_request", error_description: description },
    { status, headers: TOKEN_HEADERS },
  );
}

/** `413`, as the CLI's bounded reader answers an oversized body, with an RFC 6749 error body. */
function tooLarge(): Response {
  return tokenError(413, `The body must be at most ${MAX_FORM_BYTES} bytes`);
}

/** `POST /oauth/token`: the code exchange and the refresh, with cf-auth's status and body. */
oauthRoutes.on(["POST", "OPTIONS"], "/oauth/token", withOrigin(async (c, oauth) => {
  const body = await formBody(c);
  if (body instanceof Response) return body;
  const { status, body: answer } = await oauth.token({ body });
  return Response.json(answer, { status, headers: TOKEN_HEADERS });
}));

/** `POST /oauth/revoke` (RFC 7009): either token ends the whole connection; an unknown one is a `200` too. */
oauthRoutes.on(["POST", "OPTIONS"], "/oauth/revoke", withOrigin(async (c, oauth) => {
  const body = await formBody(c);
  if (body instanceof Response) return body;
  const { status, body: answer } = await oauth.revoke({ body });
  return answer === null
    ? new Response(null, { status, headers: TOKEN_HEADERS })
    : Response.json(answer, { status, headers: TOKEN_HEADERS });
}));
