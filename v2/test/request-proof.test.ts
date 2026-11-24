/**
 * The per-request App Attest proof (`X-AppAttest-Proof`) on the provider
 * request path: what a device signs, and every way a proof is refused.
 *
 * Ported from v1's `request-proof.test.ts`. The basic proof on `/me`, its
 * replay and a v1-path proof are in `auth-routes.test.ts`; a replay's
 * rejection event is in `proxy.test.ts`. The URL cases are shared with the
 * Swift package's own tests, which sign the same bytes.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { base64url, parseProof, PROOF_HEADER, requestClientData } from "../src/client-auth/request-proof.ts";
import urlGolden from "../../app-ai-gateway-swift/Tests/AppAIGatewayTests/Fixtures/request-proof-urls-v2.json";
import { sealSecret } from "../src/vault/secrets.ts";
import {
  ACCOUNT_ID,
  attestAuthentication,
  clearCaches,
  registerTestInstall,
  seedAccount,
  seedRoutedApp,
  testAssertion,
  tokenForInstall,
  type TestInstall,
} from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const BODY = JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

describe("the client data a device signs", () => {
  it("is these eight lines, byte for byte", async () => {
    const text = await requestClientData({
      appId: "my-app",
      method: "post",
      pathAndQuery: "/v2/apps/my-app/proxy/openai/v1/responses?x=1",
      body: new TextEncoder().encode('{"model":"gpt-5.6-sol"}'),
      token: "token-value",
      timestamp: "1767225600",
      nonce: NONCE,
    });
    // The Swift package's golden test pins the same string; only the path
    // differs from v1's, which signed `/v1/…`.
    expect(text).toBe([
      "appaigateway-request-v1",
      "my-app",
      "POST",
      "/v2/apps/my-app/proxy/openai/v1/responses?x=1",
      "-PUEzjp5RIbD6WFR4AYaosj8uORXKjdf9GqkXTE8ZjY",
      "5sAqV0LqnU3liOubnee-1D3BcBFVIYa-0-mLLFlY_0o",
      "1767225600",
      NONCE,
    ].join("\n"));
  });

  it("hashes an absent body as the empty string", async () => {
    const text = await requestClientData({
      appId: "a", method: "GET", pathAndQuery: "/", body: new Uint8Array(), token: "t", timestamp: "1", nonce: NONCE,
    });
    expect(text.split("\n")[4]).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it.each(urlGolden.cases)("reads $name the way the Swift package signs it", async (fixture) => {
    const url = new URL(`https://gateway.test${fixture.path}${fixture.query === null ? "" : `?${fixture.query}`}`);
    expect(`${url.pathname}${url.search}`).toBe(fixture.pathAndQuery);
    expect(fixture.pathAndQuery.startsWith("/v2/apps/")).toBe(true);
    const { fixed } = urlGolden;
    expect(await requestClientData({
      appId: fixed.appId,
      method: fixed.method,
      pathAndQuery: `${url.pathname}${url.search}`,
      body: new TextEncoder().encode(fixed.body),
      token: fixed.token,
      timestamp: fixed.timestamp,
      nonce: fixed.nonce,
    })).toBe(fixture.clientData);
  });

  it("parses only the v1 shape", () => {
    expect(parseProof("v1.1767225600.AAAAAAAAAAAAAAAAAAAAAA.abc_-")).toMatchObject({ timestamp: 1767225600 });
    for (const header of [
      "v2.1.AAAAAAAAAAAAAAAAAAAAAA.abc",
      "v1.1.AAAAAAAAAAAAAAAAAAAAA.abc",
      "v1.x.AAAAAAAAAAAAAAAAAAAAAA.abc",
      "v1.1.AAAAAAAAAAAAAAAAAAAAAA.",
      "v1.1.AAAAAAAAAAAAAAAAAAAAAA.ab+c",
      "v1.1.AAAAAAAAAAAAAAAAAAAAAA",
      `v1.1.AAAAAAAAAAAAAAAAAAAAAA.${"a".repeat(8193)}`,
    ]) {
      expect(() => parseProof(header), header).toThrow("X-AppAttest-Proof is malformed");
    }
  });
});

/** What a test device signs over, each field replaceable to sign the wrong thing. */
interface Signing {
  appId: string;
  method: string;
  url: string;
  body: string;
  token: string;
  timestamp: number;
  privateKey: TestInstall["privateKey"];
}

async function proofFor(install: TestInstall, signing: Signing): Promise<string> {
  install.counter += 1;
  const url = new URL(signing.url);
  const timestamp = String(signing.timestamp);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const clientData = await requestClientData({
    appId: signing.appId,
    method: signing.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    body: new TextEncoder().encode(signing.body),
    token: signing.token,
    timestamp,
    nonce,
  });
  const assertion = await testAssertion({
    privateKey: signing.privateKey,
    counter: install.counter,
    clientDataHash: new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientData))),
  });
  return `v1.${timestamp}.${nonce}.${base64url(assertion)}`;
}

let pending: ExecutionContext[] = [];
let upstream: Headers[] = [];

beforeEach(() => {
  clearCaches();
  upstream = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    upstream.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    return Response.json({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
});

afterEach(async () => {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  vi.restoreAllMocks();
});

async function send(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  pending.push(ctx);
  return new Response(await response.arrayBuffer(), response);
}

/** An App Attest app that signs every request, routed to one OpenAI connection, and one install of it. */
async function attestApp(options: { environment?: "production" | "development"; environments?: string[] } = {}) {
  await seedAccount();
  const connectionId = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${connectionId.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, connectionId, "openai", ""], "sk-proof-test");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection (id, account_id, type, slug, name, status, secret_blob, secret_hint, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, 'test', 1, 'usr_test', ?, ?)`,
  ).bind(connectionId, ACCOUNT_ID, slug, blob, now, now).run();
  const appId = await seedRoutedApp(
    attestAuthentication(options.environments === undefined ? {} : { environments: options.environments }),
    { providers: { [slug]: { operations: ["openai.chat"] } } },
  );
  const install = await registerTestInstall(appId, options.environment === undefined ? {} : { environment: options.environment });
  const token = await tokenForInstall(install);
  const url = `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`;
  const signing: Signing = {
    appId, method: "POST", url, body: BODY, token, timestamp: Math.floor(Date.now() / 1000), privateKey: install.privateKey,
  };
  return { appId, install, token, url, signing };
}

function request(url: string, token: string, proof: string | null, body = BODY): Request {
  const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json", "x-app-version": "2.0.0" });
  if (proof !== null) headers.set(PROOF_HEADER, proof);
  return new Request(url, { method: "POST", headers, body });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.clone().json()) as { error: { code: string; message: string } }).error;
}

describe("per-request App Attest proofs on the provider path", () => {
  it("accepts a signed request, and never sends the proof to the provider", async () => {
    const { install, token, url, signing } = await attestApp();
    const response = await send(request(url, token, await proofFor(install, signing)));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.has(PROOF_HEADER)).toBe(false);
  });

  it("signs the path and query exactly as sent", async () => {
    const { install, token, url, signing } = await attestApp();
    const withQuery = `${url}?trace=1`;
    expect((await send(request(withQuery, token, await proofFor(install, { ...signing, url: withQuery })))).status).toBe(200);
    // The same request signed without its query is another request.
    const response = await send(request(withQuery, token, await proofFor(install, signing)));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "attest_failed" });
  });

  it("refuses a missing proof, before calling the provider", async () => {
    const { token, url } = await attestApp();
    const response = await send(request(url, token, null));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toMatchObject({ code: "assertion_required" });
    expect(upstream).toHaveLength(0);
  });

  it("refuses a malformed proof", async () => {
    const { token, url } = await attestApp();
    const response = await send(request(url, token, "v1.nonsense"));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({ code: "attest_failed", message: "X-AppAttest-Proof is malformed" });
  });

  it.each([
    ["a day behind", -86_400],
    ["a day ahead", 86_400],
  ])("accepts a proof whose device clock is %s: the timestamp is signed, not compared", async (_label, offset) => {
    const { install, token, url, signing } = await attestApp();
    const response = await send(request(url, token, await proofFor(install, { ...signing, timestamp: signing.timestamp + offset })));
    expect(response.status).toBe(200);
  });

  it("refuses a proof whose timestamp was changed after signing", async () => {
    const { install, token, url, signing } = await attestApp();
    const [version, timestamp, nonce, assertion] = (await proofFor(install, signing)).split(".");
    const edited = [version, String(Number(timestamp) + 1), nonce, assertion].join(".");
    const response = await send(request(url, token, edited));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "attest_failed" });
  });

  it.each([
    ["another body", { body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }) }],
    ["another method", { method: "PUT" }],
    ["another token", { token: "a-different-token" }],
    ["another app", { appId: "app-someone-else" }],
  ] as const)("refuses a proof signed over %s, before calling the provider", async (_label, change) => {
    const { install, token, url, signing } = await attestApp();
    const response = await send(request(url, token, await proofFor(install, { ...signing, ...change })));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "attest_failed" });
    expect(upstream).toHaveLength(0);
  });

  it("refuses a proof over another path", async () => {
    const { install, token, url, signing } = await attestApp();
    const response = await send(request(url, token, await proofFor(install, { ...signing, url: url.replace("chat/completions", "responses") })));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "attest_failed" });
  });

  it("refuses a proof signed by a key other than the install's", async () => {
    const { appId, install, token, url, signing } = await attestApp();
    const stranger = await registerTestInstall(appId);
    const response = await send(request(url, token, await proofFor(install, { ...signing, privateKey: stranger.privateKey })));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "attest_failed" });
  });

  it("refuses a token whose install has no registered key", async () => {
    const { appId, install, token, url, signing } = await attestApp();
    await env.DB.prepare("DELETE FROM app_attest_key WHERE app_id = ?").bind(appId).run();
    clearCaches();
    const response = await send(request(url, token, await proofFor(install, signing)));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({ code: "attest_failed", message: "No matching registered App Attest key" });
  });

  it("stops a key on its next request once its environment is withdrawn", async () => {
    const { install, token, url, signing } = await attestApp({ environment: "development", environments: ["production"] });
    const response = await send(request(url, token, await proofFor(install, signing)));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: "attest_failed",
      message: "The registered App Attest environment is no longer allowed",
    });
  });

  it("accepts signed requests that arrive out of order", async () => {
    const { install, token, url, signing } = await attestApp();
    const first = request(url, token, await proofFor(install, signing));
    const second = request(url, token, await proofFor(install, signing));
    expect((await send(second)).status).toBe(200);
    expect((await send(first)).status).toBe(200);
  });
});
