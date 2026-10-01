import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { BillingRuntime } from "../src/billing/contract";
import { maintenanceSweepStatements } from "../src/auth/identity";
import { pruneExpiredAccounts, pruneOAuthTokens } from "../src/core/account-lifecycle";
import { ENDPOINT_RATE_LIMITS } from "../src/core/endpoint-rate-limit";
import { resolveDeployment } from "../src/policy/deployment";
import { clearIsolateCaches, seedHuman, seedUnaffiliatedHuman } from "./helpers";

/**
 * OAuth for MCP clients, end to end through the Worker: the discovery
 * documents, the authorization endpoint and its consent page's API, the code
 * exchange, refresh and revocation, the bearer gate on `/mcp` and
 * `/v1/admin`, the guest door onto unclaimed accounts, and what a claim, a
 * deadline and the nightly sweep do to a connection.
 *
 * Isolated in a barrel of its own: the guest door on a self-hosted
 * deployment is about the deployment being empty, so every test starts from
 * an empty database.
 */

const ORIGIN = "https://example.test";
const API_HOST = "https://api.example.test";
const BROWSER_ORIGIN = "https://inspector.example.test";
const REGISTERED = { clientId: "test-client", name: "Test Client", redirectUris: ["http://127.0.0.1/callback"] };
const CIMD_CLIENT = "https://client.example/oauth/client.json";
const CIMD_REDIRECT = "https://client.example/callback";
const MODERN = "2026-07-28";

function fakeBilling(): BillingRuntime {
  const none = { plan: null, subscription: null };
  return {
    getTenantAccess: async () => ({
      plan: { planKey: "free", planName: "Free", isDefault: true, limits: { maxRequestsPerMonth: 1000 } },
      subscription: null,
    }),
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => none,
    handleLemonWebhook: async () => ({ ok: true, duplicate: false, stale: false }),
  };
}

/** The rate limiter's object names asked for, so a test can see whether a counter was touched. */
const limiterCalls: string[] = [];

/**
 * A deployment with an identity, a separate API host, one listed browser
 * origin and one registered client: hosted unless `cloud` is false, with any
 * other variable overridden by `overrides`.
 */
function runtime(cloud = true, overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    DEPLOYMENT_ID: "oauth-tests",
    CLI_CONSOLE_ORIGIN: ORIGIN,
    PUBLIC_API_URL: API_HOST,
    MCP_ALLOWED_ORIGINS: BROWSER_ORIGIN,
    OAUTH_CLIENTS: JSON.stringify([REGISTERED]),
    BILLING: cloud ? fakeBilling() : undefined,
    ...overrides,
  };
  const limiter = {
    getByName(name: string) {
      limiterCalls.push(name);
      return env.ENDPOINT_RATE_LIMITER.getByName(name);
    },
  };
  return new Proxy(env, {
    get: (target, key, receiver) => {
      if (key === "ENDPOINT_RATE_LIMITER") return limiter;
      if (typeof key === "string" && key in values) return values[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

let address = crypto.randomUUID();

beforeEach(async () => {
  address = crypto.randomUUID();
  limiterCalls.length = 0;
  clearIsolateCaches();
  vi.restoreAllMocks();
  await env.DB.batch(
    [
      "app_api_key",
      "app",
      "provider",
      "provider_gateway",
      "mgmt_operation",
      "mgmt_verification",
      "mgmt_oauth_token",
      "mgmt_api_key",
      "mgmt_organization_user",
      "mgmt_organization",
      "mgmt_user_session",
      "mgmt_user_account",
      "mgmt_user",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Stops the clock where it is, for a test that counts against a limiter.
 *
 * The endpoint limiter counts in clock-aligned windows, read from `Date.now()`
 * in its Durable Object, which shares this isolate's clock, as
 * `test/endpoint-rate-limiter.test.ts` relies on. A burst that straddled a
 * window boundary would start a fresh count and the refusal it expects would
 * not come. Only `Date` is faked, and at the real time, so timers, the
 * database's own clock and everything cf-auth compares against it still agree.
 */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now());
}

async function request(
  testEnv: Env,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit; host?: string } = {},
): Promise<Response> {
  return worker.request(`${init.host ?? ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { "cf-connecting-ip": address, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  }, testEnv);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

interface Authorization {
  id: string;
  proof: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  state: string;
}

/** Sends a browser to `/oauth/authorize` and follows it to the consent page's id and proof. */
async function authorize(
  testEnv: Env,
  options: { clientId?: string; redirectUri?: string; scope?: string; resource?: string } = {},
): Promise<Authorization> {
  const { verifier, challenge } = await pkce();
  const clientId = options.clientId ?? REGISTERED.clientId;
  const redirectUri = options.redirectUri ?? REGISTERED.redirectUris[0]!;
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: options.resource ?? `${ORIGIN}/mcp`,
    state,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  // Its own address, so the authorization request's counter is not the
  // browser's consent counter a test is about.
  const response = await request(testEnv, `/oauth/authorize?${query}`, {
    headers: { "cf-connecting-ip": crypto.randomUUID() },
  });
  expect(response.status, await response.clone().text()).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = new URL(response.headers.get("location")!, ORIGIN);
  expect(location.origin).toBe(ORIGIN);
  expect(location.pathname).toBe("/oauth/consent");
  return {
    id: location.searchParams.get("id")!,
    proof: location.hash.slice(1),
    verifier,
    clientId,
    redirectUri,
    state,
  };
}

/** One consent page call, as the console page makes it. */
function consent(
  testEnv: Env,
  authorization: Authorization,
  step: "details" | "allow" | "guest" | "deny",
  options: { cookie?: string; body?: Record<string, unknown>; origin?: string | null } = {},
): Promise<Response> {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return request(testEnv, `/v1/console/oauth/${encodeURIComponent(authorization.id)}/${step}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: JSON.stringify({ submissionToken: authorization.proof, ...options.body }),
  });
}

async function details(testEnv: Env, authorization: Authorization, cookie?: string) {
  const response = await consent(testEnv, authorization, "details", cookie === undefined ? {} : { cookie });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<any>();
}

/** The code a consent's redirect carries, after checking it goes back to the client with `state` and `iss`. */
function codeFrom(authorization: Authorization, redirect: string): string {
  const url = new URL(redirect);
  expect(`${url.origin}${url.pathname}`).toBe(authorization.redirectUri);
  expect(url.searchParams.get("state")).toBe(authorization.state);
  expect(url.searchParams.get("iss")).toBe(ORIGIN);
  return url.searchParams.get("code")!;
}

async function allow(testEnv: Env, authorization: Authorization, cookie: string, organizationId: string, grant: "read" | "manage") {
  const response = await consent(testEnv, authorization, "allow", { cookie, body: { organizationId, grant } });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ redirect: string }>()).redirect;
}

async function guest(testEnv: Env, authorization: Authorization) {
  const response = await consent(testEnv, authorization, "guest");
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ redirect: string }>()).redirect;
}

function form(fields: Record<string, string>): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function exchange(testEnv: Env, authorization: Authorization, code: string): Promise<Tokens> {
  const response = await request(testEnv, "/oauth/token", form({
    grant_type: "authorization_code",
    code,
    redirect_uri: authorization.redirectUri,
    client_id: authorization.clientId,
    code_verifier: authorization.verifier,
    resource: `${ORIGIN}/mcp`,
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json<Tokens>();
}

async function refresh(testEnv: Env, clientId: string, refreshToken: string): Promise<Response> {
  return request(testEnv, "/oauth/token", form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }));
}

/** A person allows a registered client into their own account, and the client exchanges the code. */
async function connected(testEnv: Env, grant: "read" | "manage" = "manage") {
  const human = await seedHuman(`oauth-${crypto.randomUUID()}@example.test`);
  const authorization = await authorize(testEnv);
  const tokens = await exchange(testEnv, authorization, codeFrom(authorization, await allow(testEnv, authorization, human.cookie, human.organizationId, grant)));
  return { human, authorization, tokens };
}

let rpcId = 1;

async function mcp(testEnv: Env, token: string, method: string, params: Record<string, unknown> = {}, name?: string) {
  return request(testEnv, "/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "oauth-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function callTool(testEnv: Env, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await mcp(testEnv, token, "tools/call", { name, arguments: args }, name);
  expect(response.status, await response.clone().text()).toBe(200);
  const message = await response.json<{ result: { isError?: boolean; content: { text: string }[]; structuredContent: any } }>();
  return message.result;
}

const MCP_METADATA = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;

async function expectInvalidToken(testEnv: Env, token: string) {
  const response = await mcp(testEnv, token, "tools/list");
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="management", error="invalid_token", ${MCP_METADATA}`);
}

const session = (cookie: string) => ({ cookie, "x-console-request": "1" });

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;
}

describe("OAuth discovery", () => {
  it("publishes the three documents on the console host, readable from anywhere", async () => {
    const testEnv = runtime();
    const root = await request(testEnv, "/.well-known/oauth-protected-resource");
    expect(root.status).toBe(200);
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect(root.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await root.json()).toEqual({
      resource: ORIGIN,
      authorization_servers: [ORIGIN],
      scopes_supported: ["read", "manage"],
      bearer_methods_supported: ["header"],
    });

    const path = await request(testEnv, "/.well-known/oauth-protected-resource/mcp");
    expect(path.headers.get("access-control-allow-origin")).toBe("*");
    expect(await path.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });

    const server = await request(testEnv, "/.well-known/oauth-authorization-server");
    expect(server.headers.get("access-control-allow-origin")).toBe("*");
    expect(server.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "manage"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });

    const preflight = await request(testEnv, "/.well-known/oauth-authorization-server", {
      method: "OPTIONS",
      headers: { origin: "https://anywhere.example", "access-control-request-headers": "mcp-protocol-version" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is not there on the API host, nor where the deployment runs no OAuth", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
    ]) {
      expect((await request(runtime(), path, { host: API_HOST })).status, path).toBe(404);
      expect((await request(runtime(true, { DEPLOYMENT_ID: undefined }), path)).status, path).toBe(404);
      // Never an issuer derived from the request: without a configured
      // console origin there is no OAuth on any host.
      expect((await request(runtime(true, { CLI_CONSOLE_ORIGIN: undefined }), path)).status, path).toBe(404);
    }
    expect((await request(runtime(), "/oauth/token", { ...form({}), host: API_HOST })).status).toBe(404);
  });

  it("says CIMD is off when the deployment turned it off, and refuses an https client then", async () => {
    const testEnv = runtime(true, { OAUTH_CIMD: "false" });
    const server = await request(testEnv, "/.well-known/oauth-authorization-server");
    expect(await server.json()).toMatchObject({ client_id_metadata_document_supported: false });
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CIMD_CLIENT,
      redirect_uri: CIMD_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: ORIGIN,
    });
    const refused = await request(testEnv, `/oauth/authorize?${query}`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("location")).toBeNull();
  });
});

describe("OAuth authorization endpoint", () => {
  it("answers a client it cannot trust with an escaped error page, never a redirect", async () => {
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "<script>alert(1)</script>",
      redirect_uri: "https://evil.example/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: ORIGIN,
    });
    const response = await request(runtime(), `/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain("invalid_client");
    expect(page).not.toContain("<script>");
  });

  it("sends a request error back to the client's redirect URI with its state and the issuer", async () => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: REGISTERED.clientId,
      redirect_uri: REGISTERED.redirectUris[0]!,
      code_challenge_method: "S256",
      resource: ORIGIN,
      state: "abc",
    });
    const response = await request(runtime(), `/oauth/authorize?${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("counts authorization requests per address before reading them", async () => {
    freezeClock();
    const testEnv = runtime();
    const { limit } = ENDPOINT_RATE_LIMITS.oauth_authorize;
    for (let sent = 0; sent < limit; sent++) {
      expect((await request(testEnv, "/oauth/authorize?client_id=unknown")).status).toBe(400);
    }
    const refused = await request(testEnv, "/oauth/authorize?client_id=unknown");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(refused.headers.get("content-type")).toContain("text/html");
  });
});

describe("OAuth origin policy", () => {
  it("answers a listed browser origin's preflight on the three endpoints, and refuses any other", async () => {
    const testEnv = runtime();
    for (const path of ["/oauth/authorize", "/oauth/token", "/oauth/revoke"]) {
      const preflight = await request(testEnv, path, {
        method: "OPTIONS",
        headers: { origin: BROWSER_ORIGIN, "access-control-request-method": "POST" },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin"), path).toBe(BROWSER_ORIGIN);
      expect(preflight.headers.get("access-control-allow-methods"), path).toBe("GET, POST, OPTIONS");
      expect(preflight.headers.get("access-control-allow-headers"), path).toBe(
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      );
      expect(preflight.headers.get("vary"), path).toBe("Origin");

      const refused = await request(testEnv, path, {
        method: "OPTIONS",
        headers: { origin: "https://unlisted.example", "access-control-request-method": "POST" },
      });
      expect(refused.status, path).toBe(403);
      expect(refused.headers.get("access-control-allow-origin"), path).toBeNull();
    }

    // A listed origin's real request carries the headers too, refusals included.
    const token = await request(testEnv, "/oauth/token", {
      ...form({ grant_type: "refresh_token", refresh_token: "agw_ort_nothing.nothing", client_id: REGISTERED.clientId }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BROWSER_ORIGIN },
    });
    expect(token.status).toBe(400);
    expect(token.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
    expect(await token.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("reads at most 16 KiB of a form, counted in bytes, and stops reading past it", async () => {
    const testEnv = runtime();
    const limit = 16 * 1024;

    // No Content-Length: the stream is read until it passes the limit, then cancelled.
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 4096;
        controller.enqueue(new TextEncoder().encode("a".repeat(4096)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = await worker.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": address },
      body: endless,
      duplex: "half",
    } as RequestInit, testEnv);
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get("cache-control")).toBe("no-store");
    expect(await streamed.json()).toMatchObject({ error: "invalid_request" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(limit * 4);

    // A declared length over the limit is refused before anything is read.
    const declared = await request(testEnv, "/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(limit + 1) },
      body: "token=x",
    });
    expect(declared.status).toBe(413);

    // Bytes, not characters: 6,000 three-byte characters are 18,000 bytes.
    const multibyte = await request(testEnv, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new TextEncoder().encode(`grant_type=refresh_token&x=${"€".repeat(6000)}`),
    });
    expect(multibyte.status).toBe(413);

    // Exactly at the limit, multibyte included, is read and judged as usual.
    const prefix = `grant_type=refresh_token&client_id=${REGISTERED.clientId}&refresh_token=agw_ort_nothing.nothing&x=`;
    const fill = limit - new TextEncoder().encode(prefix).byteLength;
    const atLimit = new TextEncoder().encode(prefix + "€".repeat(Math.floor(fill / 3)) + "a".repeat(fill % 3));
    expect(atLimit.byteLength).toBe(limit);
    const judged = await request(testEnv, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: atLimit,
    });
    expect(judged.status).toBe(400);
    expect(await judged.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("takes form-encoded token and revocation bodies only", async () => {
    const testEnv = runtime();
    for (const path of ["/oauth/token", "/oauth/revoke"]) {
      const response = await request(testEnv, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      });
      expect(response.status, path).toBe(400);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(await response.json(), path).toMatchObject({ error: "invalid_request" });
    }
  });
});

describe("OAuth consent", () => {
  it("refuses a consent call from anywhere but the console's own pages", async () => {
    const testEnv = runtime();
    const authorization = await authorize(testEnv);
    expect((await consent(testEnv, authorization, "details", { origin: "https://evil.example" })).status).toBe(403);
    expect((await consent(testEnv, authorization, "details", { origin: null })).status).toBe(403);
    expect((await consent(testEnv, authorization, "deny", { origin: "https://evil.example" })).status).toBe(403);
    expect((await consent(testEnv, { ...authorization, proof: "x".repeat(43) }, "details")).status).toBe(403);
  });

  it("runs the whole flow for a registered client: consent, exchange, MCP, refresh, revoke", async () => {
    const testEnv = runtime();
    const human = await seedHuman("oauth-flow@example.test");
    const authorization = await authorize(testEnv, { scope: "read" });

    const anonymous = await details(testEnv, authorization);
    expect(anonymous).toMatchObject({
      id: authorization.id,
      state: "pending",
      client: { id: REGISTERED.clientId, name: REGISTERED.name, domain: null, source: "registered" },
      redirectHost: "127.0.0.1",
      requestedGrant: "read",
      viewer: null,
      accounts: [],
      blockedBy: "registration_required",
      guestAvailable: true,
    });
    expect(anonymous.guestExpiresAt).toEqual(expect.any(String));

    const signedIn = await details(testEnv, authorization, human.cookie);
    expect(signedIn.viewer).toEqual({ name: expect.any(String), email: human.email });
    expect(signedIn.accounts).toEqual([{ id: human.organizationId, name: expect.any(String), role: "owner" }]);
    expect(signedIn.blockedBy).toBeNull();

    // Allowing needs the person's session, and only for one of their own accounts.
    const nobody = await consent(testEnv, authorization, "allow", { body: { organizationId: human.organizationId, grant: "manage" } });
    expect(nobody.status).toBe(401);
    const other = await seedHuman("oauth-other@example.test");
    const foreign = await consent(testEnv, authorization, "allow", {
      cookie: human.cookie,
      body: { organizationId: other.organizationId, grant: "manage" },
    });
    expect(foreign.status).toBe(403);

    // The person chooses `manage` though the client asked for `read`; asking
    // again with the same proof answers the same redirect.
    const redirect = await allow(testEnv, authorization, human.cookie, human.organizationId, "manage");
    expect(await allow(testEnv, authorization, human.cookie, human.organizationId, "manage")).toBe(redirect);
    const tokens = await exchange(testEnv, authorization, codeFrom(authorization, redirect));
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: "manage" });
    expect(tokens.access_token.startsWith("agw_oat_")).toBe(true);
    expect(tokens.refresh_token.startsWith("agw_ort_")).toBe(true);

    const account = await callTool(testEnv, tokens.access_token, "get_account");
    expect(account.isError, account.content[0]?.text).toBeFalsy();
    expect(account.structuredContent.account).toMatchObject({ id: human.organizationId, claimed: true });

    // The same token on the management API, as `api`.
    const apps = await request(testEnv, "/v1/admin/apps", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(apps.status, await apps.clone().text()).toBe(200);

    const refreshed = await refresh(testEnv, authorization.clientId, tokens.refresh_token);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("no-store");
    const next = await refreshed.json<Tokens>();
    expect(next.access_token).not.toBe(tokens.access_token);
    await expectInvalidToken(testEnv, tokens.access_token);
    expect((await callTool(testEnv, next.access_token, "get_account")).isError).toBeFalsy();

    // The access page lists the connection beside the keys, and revokes it there.
    const listed = await request(testEnv, "/v1/admin/keys", { headers: session(human.cookie) });
    const { keys } = await listed.json<{ keys: any[] }>();
    const connection = keys.find((key) => key.source === "oauth");
    expect(connection).toMatchObject({
      name: REGISTERED.name,
      clientId: REGISTERED.clientId,
      grant: "manage",
      organizationId: human.organizationId,
      revokedAt: null,
    });
    expect(connection.expiresAt).toEqual(expect.any(String));
    const revoked = await request(testEnv, `/v1/admin/keys/${connection.id}/revoke`, {
      method: "POST",
      headers: { ...session(human.cookie), "content-type": "application/json" },
      body: "{}",
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    await expectInvalidToken(testEnv, next.access_token);
    expect((await refresh(testEnv, authorization.clientId, next.refresh_token)).status).toBe(400);
  });

  it("names a CIMD client as its document declares it, and denies back to the client", async () => {
    const testEnv = runtime();
    const declared = "<b>Agent</b> & friends";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(CIMD_CLIENT);
      return Response.json({
        client_id: CIMD_CLIENT,
        client_name: declared,
        redirect_uris: [CIMD_REDIRECT],
        token_endpoint_auth_method: "none",
      });
    });
    const authorization = await authorize(testEnv, { clientId: CIMD_CLIENT, redirectUri: CIMD_REDIRECT });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const shown = await details(testEnv, authorization);
    // Untrusted text, handed over as it was declared for the page to render as text.
    expect(shown.client).toEqual({ id: CIMD_CLIENT, name: declared, domain: "client.example", source: "cimd" });
    expect(shown.redirectHost).toBe("client.example");

    const denied = await consent(testEnv, authorization, "deny");
    expect(denied.status).toBe(200);
    const redirect = new URL((await denied.json<{ redirect: string }>()).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CIMD_REDIRECT);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(authorization.state);
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  });
});

describe("OAuth guest door", () => {
  it("creates one unclaimed account per authorization, however often it is pressed", async () => {
    const testEnv = runtime();
    const authorization = await authorize(testEnv, { scope: "read" });
    const before = await count("SELECT count(*) AS n FROM mgmt_organization");

    const [first, second] = await Promise.all([
      consent(testEnv, authorization, "guest"),
      consent(testEnv, authorization, "guest"),
    ]);
    // Of two clicks racing, one completes it; the other is answered the same
    // redirect, or told it lost and may ask again, which then answers it.
    const answers = await Promise.all([first, second].map(async (response) =>
      response.status === 200 ? (await response.json<{ redirect: string }>()).redirect : null));
    expect(answers.some((answer) => answer !== null)).toBe(true);
    const redirect = answers.find((answer) => answer !== null)!;
    expect(await guest(testEnv, authorization)).toBe(redirect);
    for (const answer of answers) if (answer !== null) expect(answer).toBe(redirect);
    expect(await count("SELECT count(*) AS n FROM mgmt_organization")).toBe(before + 1);

    // The connection has `manage`, and the record says the client asked for `read`.
    const tokens = await exchange(testEnv, authorization, codeFrom(authorization, redirect));
    expect(tokens.scope).toBe("manage");
    const record = await env.DB.prepare("SELECT outcome FROM mgmt_operation WHERE id = ?").bind(authorization.id).first<{ outcome: string }>();
    expect(JSON.parse(record!.outcome)).toMatchObject({ door: "guest", grant: "manage", requestedGrant: "read" });

    // An unclaimed account, owned by the door's service identity, with a deadline.
    const account = await callTool(testEnv, tokens.access_token, "get_account");
    expect(account.isError, account.content[0]?.text).toBeFalsy();
    expect(account.structuredContent.account).toMatchObject({ claimed: false, expiresAt: expect.any(String) });
    expect(account.content[0]!.text).toContain("claim_account");
    const owner = await env.DB.prepare(
      "SELECT u.name, u.kind FROM mgmt_organization o JOIN mgmt_user u ON u.id = o.created_by_user_id WHERE o.id = ?",
    ).bind(account.structuredContent.account.id).first<{ name: string; kind: string }>();
    expect(owner).toEqual({ name: "MCP connection", kind: "service" });

    // A second authorization is a second account.
    await guest(testEnv, await authorize(testEnv));
    expect(await count("SELECT count(*) AS n FROM mgmt_organization")).toBe(before + 2);
  });

  it("counts accounts per browser address with the CLI's bootstrap", async () => {
    freezeClock();
    const testEnv = runtime();
    for (let created = 0; created < ENDPOINT_RATE_LIMITS.bootstrap.limit; created++) {
      await guest(testEnv, await authorize(testEnv));
    }
    const refused = await consent(testEnv, await authorize(testEnv), "guest");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/u);
  });

  it("is offered on an empty self-hosted deployment, and closes it as the CLI's bootstrap does", async () => {
    const testEnv = runtime(false);
    expect(await count("SELECT count(*) AS n FROM mgmt_organization")).toBe(0);
    const first = await authorize(testEnv);
    const offered = await details(testEnv, first);
    expect(offered).toMatchObject({ guestAvailable: true, guestExpiresAt: null });

    const tokens = await exchange(testEnv, first, codeFrom(first, await guest(testEnv, first)));
    // Not counted: a self-host's first caller is its owner, whoever it is.
    expect((await callTool(testEnv, tokens.access_token, "get_account")).structuredContent.account).toMatchObject({
      id: "private-oauth-tests",
      claimed: false,
      expiresAt: null,
    });

    // Registration's window closed with it, as after a CLI bootstrap.
    const capabilities = await request(testEnv, "/v1/console/capabilities");
    expect(await capabilities.json()).toMatchObject({ registrationOpen: false });

    // Nobody else gets in through the door, and the refusal spends no allowance.
    const second = await authorize(testEnv);
    expect(await details(testEnv, second)).toMatchObject({ guestAvailable: false, guestExpiresAt: null });
    limiterCalls.length = 0;
    const refused = await consent(testEnv, second, "guest");
    expect(refused.status).toBe(409);
    expect(limiterCalls).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM mgmt_organization")).toBe(1);
  });

  it("is not offered on a self-hosted deployment a person already owns", async () => {
    const testEnv = runtime(false);
    await seedHuman("oauth-selfhost-owner@example.test");
    const authorization = await authorize(testEnv);
    expect(await details(testEnv, authorization)).toMatchObject({ guestAvailable: false });
    limiterCalls.length = 0;
    expect((await consent(testEnv, authorization, "guest")).status).toBe(409);
    expect(limiterCalls).toEqual([]);
  });
});

describe("OAuth grants and the bearer gate", () => {
  it("refuses a read connection's change as a tool result over MCP, and with a challenge on the API", async () => {
    const testEnv = runtime();
    const { tokens } = await connected(testEnv, "read");
    expect(tokens.scope).toBe("read");

    const tool = await callTool(testEnv, tokens.access_token, "add_provider", { type: "openai", name: "Read" });
    expect(tool.isError).toBe(true);
    expect(tool.structuredContent.error).toBe("grant_insufficient");

    const write = await request(testEnv, "/v1/admin/apps", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(write.status).toBe(403);
    // No resource metadata: no published document's `resource` is this URL,
    // so discovery stays on `/mcp`.
    expect(write.headers.get("www-authenticate")).toBe('Bearer realm="management", error="insufficient_scope", scope="manage"');
    expect(await write.json()).toMatchObject({ error: { code: "grant_insufficient" } });
  });

  it("never lets a token administer keys, which is a person's own", async () => {
    const testEnv = runtime();
    const { tokens } = await connected(testEnv);
    const headers = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" };
    const created = await request(testEnv, "/v1/admin/keys", { method: "POST", headers, body: JSON.stringify({ name: "Escalate" }) });
    expect(created.status).toBe(403);
    expect(await created.json()).toMatchObject({ error: { code: "session_required" } });
    const listed = await request(testEnv, "/v1/admin/keys", { headers });
    expect(listed.status).toBe(403);
  });

  it("challenges on the management API without naming metadata, which only /mcp does", async () => {
    const testEnv = runtime();
    const none = await request(testEnv, "/v1/admin/apps");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer realm="management"');
    const dead = await request(testEnv, "/v1/admin/apps", { headers: { authorization: "Bearer agw_oat_nothing.nothing" } });
    expect(dead.status).toBe(401);
    expect(dead.headers.get("www-authenticate")).toBe('Bearer realm="management", error="invalid_token"');
  });

  it("accepts no token and names no metadata where the console origin is not configured", async () => {
    const { tokens } = await connected(runtime());
    const unconfigured = runtime(true, { CLI_CONSOLE_ORIGIN: undefined });
    const mcpRefusal = await mcp(unconfigured, tokens.access_token, "tools/list");
    expect(mcpRefusal.status).toBe(401);
    expect(mcpRefusal.headers.get("www-authenticate")).toBe('Bearer realm="management", error="invalid_token"');
    const missing = await mcp(unconfigured, "", "tools/list");
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="management"');
    const admin = await request(unconfigured, "/v1/admin/apps", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(admin.status).toBe(401);
    // The same token is good where the origin is configured.
    expect((await callTool(runtime(), tokens.access_token, "get_account")).isError).toBeFalsy();
  });

  it("keeps a token off the CLI's own surface", async () => {
    const testEnv = runtime();
    const { tokens } = await connected(testEnv);
    const account = await request(testEnv, "/v1/cli/account", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(account.status).toBe(401);
  });
});

describe("OAuth connection lifecycle", () => {
  it("keeps a guest connection through its account's claim, for the new owner to see and end", async () => {
    const testEnv = runtime();
    const authorization = await authorize(testEnv);
    const tokens = await exchange(testEnv, authorization, codeFrom(authorization, await guest(testEnv, authorization)));

    const claim = await callTool(testEnv, tokens.access_token, "claim_account");
    expect(claim.isError, claim.content[0]?.text).toBeFalsy();
    const url = new URL(claim.structuredContent.url);
    const person = await seedUnaffiliatedHuman("oauth-claimer@example.test");
    const approved = await request(testEnv, `/v1/cli/browser/${url.pathname.split("/").pop()}/submit`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: person.cookie, "content-type": "application/json" },
      body: JSON.stringify({ submissionToken: url.hash.slice(1), approve: true }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);

    const after = await callTool(testEnv, tokens.access_token, "get_account");
    expect(after.isError, after.content[0]?.text).toBeFalsy();
    expect(after.structuredContent.account).toMatchObject({ claimed: true });

    const listed = await request(testEnv, "/v1/admin/keys", { headers: session(person.cookie) });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const connection = (await listed.json<{ keys: any[] }>()).keys.find((key) => key.source === "oauth");
    expect(connection).toMatchObject({ clientId: REGISTERED.clientId, grant: "manage" });
    const revoked = await request(testEnv, `/v1/admin/keys/${connection.id}/revoke`, {
      method: "POST",
      headers: { ...session(person.cookie), "content-type": "application/json" },
      body: "{}",
    });
    expect(revoked.status).toBe(200);
    await expectInvalidToken(testEnv, tokens.access_token);
  });

  it("ends an unclaimed account's connection at its deadline, refresh included, and collects it with the account", async () => {
    const testEnv = runtime();
    const authorization = await authorize(testEnv);
    const tokens = await exchange(testEnv, authorization, codeFrom(authorization, await guest(testEnv, authorization)));
    const accountId = (await callTool(testEnv, tokens.access_token, "get_account")).structuredContent.account.id as string;

    await env.DB.prepare("UPDATE mgmt_organization SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), accountId)
      .run();
    clearIsolateCaches();
    await expectInvalidToken(testEnv, tokens.access_token);
    const refused = await refresh(testEnv, authorization.clientId, tokens.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });

    expect(await count("SELECT count(*) AS n FROM mgmt_oauth_token t JOIN mgmt_api_key k ON k.id = t.api_key_id WHERE k.organization_id = ?", accountId)).toBe(1);
    await pruneExpiredAccounts(env.DB);
    expect(await count("SELECT count(*) AS n FROM mgmt_organization WHERE id = ?", accountId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM mgmt_api_key WHERE organization_id = ?", accountId)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM mgmt_oauth_token")).toBe(0);
  });

  it("sweeps the tokens of a connection that lapsed, nightly", async () => {
    const testEnv = runtime();
    const { human } = await connected(testEnv);
    expect(await count("SELECT count(*) AS n FROM mgmt_oauth_token")).toBe(1);
    await env.DB.prepare("UPDATE mgmt_api_key SET expires_at = ? WHERE organization_id = ? AND source = 'oauth'")
      .bind(Date.now() - 60_000, human.organizationId)
      .run();
    const sweeps = await maintenanceSweepStatements(resolveDeployment(testEnv), testEnv, env.DB, Date.now());
    expect(sweeps.oauth).toHaveLength(1);
    await pruneOAuthTokens(env.DB, sweeps.oauth!);
    expect(await count("SELECT count(*) AS n FROM mgmt_oauth_token")).toBe(0);

    // A deployment that runs no OAuth has nothing to sweep, and its
    // operation sweep still runs.
    for (const overrides of [{ DEPLOYMENT_ID: undefined }, { CLI_CONSOLE_ORIGIN: undefined }]) {
      const without = runtime(true, overrides);
      const skipped = await maintenanceSweepStatements(resolveDeployment(without), without, env.DB, Date.now());
      expect(skipped.oauth, JSON.stringify(overrides)).toBeNull();
    }
    const unconfigured = runtime(true, { CLI_CONSOLE_ORIGIN: undefined });
    expect((await maintenanceSweepStatements(resolveDeployment(unconfigured), unconfigured, env.DB, Date.now())).operations.length)
      .toBeGreaterThan(0);
  });
});
