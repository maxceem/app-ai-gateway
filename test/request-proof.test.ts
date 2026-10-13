import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { issueGatewayToken } from "../src/client-auth/gateway-token";
import { parseProof, requestClientData } from "../src/client-auth/request-proof";
import { legacyMode, noteUnsignedRequest } from "../src/client-auth/legacy";
import { appConfigCache, loadApp } from "../src/core/app-records";
// Shared with the Swift package's tests, byte for byte: both sides must sign
// the path and query exactly as this runtime's URL parser reads them.
import urlGolden from "../app-ai-gateway-swift/Tests/AppAIGatewayTests/Fixtures/request-proof-urls.json";
import {
  clearIsolateCaches,
  registerTestInstall,
  seedApp,
  seedServerApp,
  signedProof,
  tokenForInstall,
  type TestInstall,
} from "./helpers";

/**
 * Every request an App Attest application's gateway token is sent with must
 * carry `X-AppAttest-Proof`: an assertion the install's key signed over that
 * very request. These drive the whole served path — token, proof, limiter —
 * with a P-256 key standing in for the device's.
 */

const ORIGIN = "https://example.test";
let pending: ExecutionContext[] = [];

afterEach(async () => {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  vi.restoreAllMocks();
});

async function send(request: Request, bindings: Env = env): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await worker.fetch(request, bindings, executionCtx);
  pending.push(executionCtx);
  return new Response(await response.arrayBuffer(), response);
}

/** An upstream that answers every call, keeping the headers it was sent. */
function upstream(): Headers[] {
  const seen: Headers[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    seen.push(new Headers(init?.headers));
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  });
  return seen;
}

const BODY = JSON.stringify({ model: "gpt-5.6-sol", input: "hello" });

function proxyUrl(appId: string, query = ""): string {
  return `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses${query}`;
}

/** A proxied request, signed by `install` unless `proof` says otherwise. */
async function proxied(
  install: TestInstall,
  token: string,
  options: {
    body?: string;
    url?: string;
    proof?: string | null;
    sign?: Partial<Parameters<typeof signedProof>[0]>;
  } = {},
): Promise<Request> {
  const url = options.url ?? proxyUrl(install.appId);
  const body = options.body ?? BODY;
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-app-version": "2.0.0",
  });
  if (options.proof !== null) {
    install.counter += 1;
    headers.set("x-appattest-proof", options.proof ?? await signedProof({
      appId: install.appId,
      privateKey: install.privateKey,
      token,
      method: "POST",
      url,
      body: new TextEncoder().encode(body),
      counter: install.counter,
      ...options.sign,
    }));
  }
  return new Request(url, { method: "POST", headers, body });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

async function attestApp(appId: string, options: Parameters<typeof seedApp>[1] = {}) {
  await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} }, ...options });
  const install = await registerTestInstall(appId);
  return { install, token: await tokenForInstall(install) };
}

describe("the client data a device signs", () => {
  it("is these eight lines, byte for byte", async () => {
    const text = await requestClientData({
      appId: "my-app",
      method: "post",
      pathAndQuery: "/v1/apps/my-app/proxy/openai/v1/responses?x=1",
      body: new TextEncoder().encode('{"model":"gpt-5.6-sol"}'),
      token: "token-value",
      timestamp: "1767225600",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    // The Swift package's golden test pins the same string.
    expect(text).toBe([
      "appaigateway-request-v1",
      "my-app",
      "POST",
      "/v1/apps/my-app/proxy/openai/v1/responses?x=1",
      "-PUEzjp5RIbD6WFR4AYaosj8uORXKjdf9GqkXTE8ZjY",
      "5sAqV0LqnU3liOubnee-1D3BcBFVIYa-0-mLLFlY_0o",
      "1767225600",
      "AAAAAAAAAAAAAAAAAAAAAA",
    ].join("\n"));
  });

  it("hashes an absent body as the empty string", async () => {
    const text = await requestClientData({
      appId: "a", method: "GET", pathAndQuery: "/", body: new Uint8Array(),
      token: "t", timestamp: "1", nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(text.split("\n")[4]).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  /**
   * The gateway rebuilds the signed path and query from `request.url`, which
   * the runtime has already read with the WHATWG URL parser. The Swift
   * package normalizes the URL it sends to that same form before signing;
   * these fixtures are the contract between the two.
   */
  it.each(urlGolden.cases)("reads $name the way the Swift package signs it", async (fixture) => {
    const url = new URL(`https://gateway.test${fixture.path}${fixture.query === null ? "" : `?${fixture.query}`}`);
    expect(`${url.pathname}${url.search}`).toBe(fixture.pathAndQuery);
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
    ]) {
      expect(() => parseProof(header), header).toThrow("X-AppAttest-Proof is malformed");
    }
  });
});

describe("per-request App Attest proofs", () => {
  it("accepts a signed request, and never forwards the proof upstream", async () => {
    const { install, token } = await attestApp("proof-accepted");
    const seen = upstream();
    const response = await send(await proxied(install, token));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.has("x-appattest-proof")).toBe(false);
    expect(response.headers.has("deprecation")).toBe(false);
  });

  it("signs the path and query exactly as sent", async () => {
    const { install, token } = await attestApp("proof-query");
    upstream();
    const url = proxyUrl("proof-query", "?trace=1");
    expect((await send(await proxied(install, token, { url }))).status).toBe(200);
    // The same proof shape over the path without its query is another request.
    const response = await send(await proxied(install, token, { url, sign: { url: proxyUrl("proof-query") } }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "attest_failed" });
  });

  it("refuses a missing proof with a message that stands on its own", async () => {
    const { install, token } = await attestApp("proof-missing");
    const fetchSpy = upstream();
    const response = await send(await proxied(install, token, { proof: null }));
    expect(response.status).toBe(401);
    await expect(errorOf(response)).resolves.toEqual({
      code: "assertion_required",
      message: "This app requires every request to be signed with App Attest. Update the AppAIGateway Swift package to 2.x.",
    });
    expect(fetchSpy).toHaveLength(0);
  });

  it("refuses a malformed proof", async () => {
    const { install, token } = await attestApp("proof-malformed");
    const response = await send(await proxied(install, token, { proof: "v1.nonsense" }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toEqual({
      code: "attest_failed",
      message: "X-AppAttest-Proof is malformed",
    });
  });

  it.each([
    ["a day behind", -86_400],
    ["a day ahead", 86_400],
  ])("accepts a proof whose device clock is %s: the timestamp is signed, not compared", async (_label, offset) => {
    const { install, token } = await attestApp(`proof-clock-${offset}`);
    upstream();
    const response = await send(await proxied(install, token, {
      sign: { timestamp: Math.floor(Date.now() / 1000) + offset },
    }));
    expect(response.status).toBe(200);
  });

  it("refuses a proof whose timestamp was changed after signing", async () => {
    const { install, token } = await attestApp("proof-timestamp-edited");
    const signed = await proxied(install, token);
    const [version, timestamp, nonce, assertion] = signed.headers.get("x-appattest-proof")!.split(".");
    const headers = new Headers(signed.headers);
    headers.set("x-appattest-proof", [version, String(Number(timestamp) + 1), nonce, assertion].join("."));
    const response = await send(new Request(signed.url, { method: "POST", headers, body: BODY }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "attest_failed" });
  });

  it.each([
    ["another body", { body: new TextEncoder().encode('{"model":"gpt-5.6-sol","input":"bye"}') }],
    ["another path", { url: `${ORIGIN}/v1/apps/proof-wrong/proxy/openai/v1/chat/completions` }],
    ["another method", { method: "PUT" }],
    ["another token", { token: "a-different-token" }],
    ["another app", { appId: "proof-other-app" }],
  ])("refuses a proof signed over %s", async (_label, sign) => {
    const appId = `proof-wrong-${crypto.randomUUID()}`;
    const { install, token } = await attestApp(appId);
    const fetchSpy = upstream();
    const response = await send(await proxied(install, token, {
      sign: { rpId: `AAAAAAAAAA.com.example.${appId}`, ...sign },
    }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "attest_failed" });
    expect(fetchSpy).toHaveLength(0);
  });

  it("refuses a proof signed by a key other than the install's", async () => {
    const { install, token } = await attestApp("proof-other-key");
    const stranger = await registerTestInstall("proof-other-key", "someone-else");
    const response = await send(await proxied(install, token, { sign: { privateKey: stranger.privateKey } }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "attest_failed" });
  });

  it("refuses a token whose install has no registered key", async () => {
    const { install, token } = await attestApp("proof-unknown-key");
    await env.DB.prepare("DELETE FROM app_attest_key WHERE app_id = ?").bind("proof-unknown-key").run();
    clearIsolateCaches();
    const response = await send(await proxied(install, token));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toEqual({
      code: "attest_failed",
      message: "No matching registered App Attest key",
    });
  });

  it("stops a key on its next request once its environment is withdrawn", async () => {
    await seedApp("proof-withdrawn", { proxy: { provider_mode: "all", model_rewrites: {} } });
    const install = await registerTestInstall("proof-withdrawn", "user-1", { environment: "development" });
    const token = await tokenForInstall(install);
    const response = await send(await proxied(install, token));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toEqual({
      code: "attest_failed",
      message: "The registered App Attest environment is no longer allowed",
    });
  });

  it("refuses a replayed proof, and records it against the install", async () => {
    const { install, token } = await attestApp("proof-replay");
    upstream();
    const request = await proxied(install, token);
    const replay = request.clone() as Request;
    expect((await send(request)).status).toBe(200);
    const response = await send(replay);
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toEqual({
      code: "attest_failed",
      message: "App Attest assertion counter was replayed",
    });
    await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
    const row = await env.DB.prepare(
      "SELECT reason, scope, install_id FROM app_rejection_event WHERE app_id = ? ORDER BY id DESC LIMIT 1",
    ).bind("proof-replay").first();
    expect(row).toEqual({ reason: "blocked_replay", scope: "install", install_id: install.keyId });
  });

  it("accepts signed requests that arrive out of order", async () => {
    const { install, token } = await attestApp("proof-order");
    upstream();
    const first = await proxied(install, token);
    const second = await proxied(install, token);
    expect((await send(second)).status).toBe(200);
    expect((await send(first)).status).toBe(200);
  });

  it("refuses an API-key token on an App Attest application", async () => {
    const { install } = await attestApp("proof-policy-attest");
    const { token } = await issueGatewayToken(env.JWT_SECRET, {
      appId: "proof-policy-attest",
      userId: "user-1",
      authMethod: "api_key",
    });
    const response = await send(await proxied(install, token, { proof: null }));
    expect(response.status).toBe(401);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "auth_required" });
  });

  it("refuses an attest token on an API-key application", async () => {
    await seedServerApp("proof-policy-server", {
      issuer: {},
      proxy: { provider_mode: "all", model_rewrites: {} },
    });
    const install = await registerTestInstall("proof-policy-server");
    const token = await tokenForInstall(install);
    const response = await send(await proxied(install, token));
    expect(response.status).toBe(401);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "auth_required" });
  });

  it("ignores a proof beside an API key, and never forwards it", async () => {
    const key = await seedServerApp("proof-server-key", {
      endUser: "none",
      proxy: { provider_mode: "all", model_rewrites: {} },
    });
    const seen = upstream();
    const response = await send(new Request(proxyUrl("proof-server-key"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-appattest-proof": "v1.nonsense",
      },
      body: BODY,
    }));
    expect(response.status).toBe(200);
    expect(seen[0]!.has("x-appattest-proof")).toBe(false);
  });

  it("signs /me like any other request, and reports the install", async () => {
    const { install, token } = await attestApp("proof-me");
    const url = `${ORIGIN}/v1/apps/proof-me/me`;
    const unsigned = await send(new Request(url, { headers: { authorization: `Bearer ${token}` } }));
    expect(unsigned.status).toBe(401);
    await expect(errorOf(unsigned)).resolves.toMatchObject({ code: "assertion_required" });

    install.counter += 1;
    const proof = await signedProof({
      appId: "proof-me",
      privateKey: install.privateKey,
      token,
      method: "GET",
      url,
      counter: install.counter,
    });
    const signed = new Request(url, { headers: { authorization: `Bearer ${token}`, "x-appattest-proof": proof } });
    const replay = signed.clone() as Request;
    const response = await send(signed);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user_id: "user-1", install_id: install.keyId });
    // A proof captured off /me is spent there too.
    const replayed = await send(replay);
    expect(replayed.status).toBe(403);
    await expect(errorOf(replayed)).resolves.toMatchObject({ code: "attest_failed" });
    // And sampled the way a replayed proxy request is.
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    const row = await env.DB.prepare(
      "SELECT reason, scope, install_id, route, provider_slug FROM app_rejection_event WHERE app_id = 'proof-me' ORDER BY id DESC LIMIT 1",
    ).first();
    expect(row).toEqual({
      reason: "blocked_replay",
      scope: "install",
      install_id: install.keyId,
      route: "me",
      provider_slug: null,
    });
  });
});

/**
 * The `unsigned_requests` legacy mode: dated, set by migration 0006 or by hand in D1 for
 * an application whose shipped build cannot sign yet.
 */
describe("the unsigned_requests legacy mode", () => {
  async function withLegacy(appId: string, legacy: string | null) {
    const seeded = await attestApp(appId);
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = ?").bind(legacy, appId).run();
    clearIsolateCaches();
    return seeded;
  }

  const live = () => JSON.stringify({
    unsigned_requests: { until: "2099-01-31T00:00:00Z" },
  });

  it("accepts an unsigned request while live, and says when it stops", async () => {
    const { install, token } = await withLegacy("legacy-live", live());
    upstream();
    const warn = vi.spyOn(console, "warn");
    const response = await send(await proxied(install, token, { proof: null }));
    expect(response.status).toBe(200);
    expect(response.headers.get("deprecation")).toBe("true");
    expect(response.headers.get("sunset")).toBe("Sat, 31 Jan 2099 00:00:00 GMT");
    expect(response.headers.get("link")).toBe(
      '<https://docs.appaigateway.com/integrate/ios#per-request-proof>; rel="sunset"',
    );
    const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({
      message: "legacy_unsigned_requests_used",
      app: "legacy-live",
      until: "2099-01-31T00:00:00.000Z",
    }));
  });

  it("carries the notice on a refusal too", async () => {
    const { install, token } = await withLegacy("legacy-refusal", live());
    // No such provider path is allowed, so the request is refused after it
    // was accepted under the switch.
    const response = await send(await proxied(install, token, {
      proof: null,
      url: `${ORIGIN}/v1/apps/legacy-refusal/proxy/nope/v1/responses`,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("deprecation")).toBe("true");
  });

  it("still verifies a proof that is present", async () => {
    const { install, token } = await withLegacy("legacy-proof", live());
    upstream();
    expect((await send(await proxied(install, token))).status).toBe(200);
    const response = await send(await proxied(install, token, { sign: { token: "other" } }));
    expect(response.status).toBe(403);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "attest_failed" });
  });

  /**
   * A token minted before installs existed names none. A shipped 1.x client
   * holds one for up to an hour after the gateway is updated, and under the
   * switch that hour must not lock it out.
   */
  it("accepts a token from before installs existed, only while live and only unsigned", async () => {
    const legacyToken = async (appId: string) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ app: appId, auth_method: "attest" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject("user-1")
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setJti(crypto.randomUUID())
        .sign(new TextEncoder().encode(env.JWT_SECRET));
    };
    const { install } = await withLegacy("legacy-legacy-token", live());
    upstream();
    const token = await legacyToken("legacy-legacy-token");
    const accepted = await send(await proxied(install, token, { proof: null }));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("deprecation")).toBe("true");
    // A proof needs an install to be checked against.
    const signed = await send(await proxied(install, token));
    expect(signed.status).toBe(401);
    await expect(errorOf(signed)).resolves.toMatchObject({ code: "auth_required" });

    const { install: other } = await withLegacy("legacy-legacy-off", null);
    const refused = await send(await proxied(other, await legacyToken("legacy-legacy-off"), { proof: null }));
    expect(refused.status).toBe(401);
    await expect(errorOf(refused)).resolves.toMatchObject({ code: "auth_required" });
  });

  it("stops on its date", async () => {
    const { install, token } = await withLegacy("legacy-expired", JSON.stringify({
      unsigned_requests: { until: "2020-01-01T00:00:00Z" },
    }));
    const response = await send(await proxied(install, token, { proof: null }));
    expect(response.status).toBe(401);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "assertion_required" });
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown switch", JSON.stringify({ something_else: { until: "2099-01-01T00:00:00Z" } })],
    ["a date without a time", JSON.stringify({ unsigned_requests: { until: "2099-01-01" } })],
  ])("switches nothing on for %s, and logs it", async (_label, legacy) => {
    const appId = `legacy-invalid-${crypto.randomUUID()}`;
    const { install, token } = await withLegacy(appId, legacy);
    const warn = vi.spyOn(console, "warn");
    const response = await send(await proxied(install, token, { proof: null }));
    expect(response.status).toBe(401);
    await expect(errorOf(response)).resolves.toMatchObject({ code: "assertion_required" });
    const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({ message: "legacy_invalid", app: appId }));
  });
});

describe("installs in usage and the user list", () => {
  const admin = (path: string) => send(new Request(`${ORIGIN}/v1/admin/apps/${path}`, {
    headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
  }));

  it("records each request's install, groups by it, and counts a user's installs", async () => {
    const appId = "installs-usage";
    const { install: phone, token: phoneToken } = await attestApp(appId);
    const tablet = await registerTestInstall(appId);
    const tabletToken = await tokenForInstall(tablet);
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, 'user-1')").bind(appId).run();
    upstream();
    expect((await send(await proxied(phone, phoneToken))).status).toBe(200);
    expect((await send(await proxied(phone, phoneToken))).status).toBe(200);
    expect((await send(await proxied(tablet, tabletToken))).status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));

    const breakdown = await admin(`${appId}/usage/breakdown?by=install`);
    expect(breakdown.status).toBe(200);
    const { rows } = await breakdown.json<{ rows: { key: string; requests: number }[] }>();
    expect(rows.map(({ key, requests }) => ({ key, requests }))).toEqual([
      { key: phone.keyId, requests: 2 },
      { key: tablet.keyId, requests: 1 },
    ]);

    const events = await admin(`${appId}/events?install=${encodeURIComponent(tablet.keyId)}`);
    const listed = await events.json<{ events: { install_id: string; user_id: string }[] }>();
    expect(listed.events).toEqual([expect.objectContaining({ install_id: tablet.keyId, user_id: "user-1" })]);

    const users = await admin(`${appId}/users`);
    const { users: rowsByUser } = await users.json<{ users: { id: string; installs: number; attest_registered: boolean }[] }>();
    expect(rowsByUser).toEqual([expect.objectContaining({ id: "user-1", installs: 2, attest_registered: true })]);
  });

  /**
   * Whether a row is one install is decided from the row, not from the app's
   * current setting: a signed-in user's history survives a move to
   * app_install and must not read as an install.
   */
  it("marks each row an install or not by its own key, across a change of identity", async () => {
    const appId = "installs-switch";
    await seedApp(appId);
    await registerTestInstall(appId, "person");
    await registerTestInstall(appId, "person");
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, 'person')").bind(appId).run();
    // The app moves to app_install, and a first install registers under it.
    const row = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(appId).first<{ config_json: string }>();
    const config = JSON.parse(row!.config_json);
    config.authentication.end_user = { source: "app_install" };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), appId).run();
    clearIsolateCaches();
    await registerTestInstall(appId, "install-key-1", { keyId: "install-key-1" });
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, 'install-key-1')").bind(appId).run();

    const users = await admin(`${appId}/users`);
    const { users: rows } = await users.json<{ users: { id: string; installs: number; is_install: boolean }[] }>();
    expect(rows.find((user) => user.id === "person")).toMatchObject({ installs: 2, is_install: false });
    expect(rows.find((user) => user.id === "install-key-1")).toMatchObject({ installs: 1, is_install: true });
  });

  it("counts no installs for a server application's users", async () => {
    const key = await seedServerApp("installs-server", { proxy: { provider_mode: "all", model_rewrites: {} } });
    upstream();
    const response = await send(new Request(proxyUrl("installs-server"), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "u" },
      body: BODY,
    }));
    expect(response.status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    const users = await admin("installs-server/users");
    const { users: rows } = await users.json<{ users: { id: string; installs: number }[] }>();
    expect(rows).toEqual([expect.objectContaining({ id: "u", installs: 0 })]);
    const event = await env.DB.prepare("SELECT install_id FROM app_usage_event WHERE app_id = 'installs-server'").first();
    expect(event).toEqual({ install_id: null });
  });
});

describe("an application's warnings", () => {
  const admin = (path: string, init: RequestInit = {}) => send(new Request(`${ORIGIN}/v1/admin/apps/${path}`, {
    ...init,
    headers: {
      authorization: "Bearer agw_mgmt_test-admin-secret",
      "content-type": "application/json",
      ...init.headers,
    },
  }));

  it("describes a live legacy mode on read, and nothing once it ends", async () => {
    await seedApp("warnings-live");
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = 'warnings-live'")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } })).run();
    const response = await admin("warnings-live");
    expect(response.status).toBe(200);
    const { app } = await response.json<{ app: { warnings: unknown[] } }>();
    expect(app.warnings).toEqual([{
      code: "legacy_unsigned_requests",
      legacy: "unsigned_requests",
      message: "Legacy mode: requests without an App Attest proof are accepted until 2099-01-31T00:00:00Z. Update the app to AppAIGateway Swift package 2.x, then disable legacy mode.",
      until: "2099-01-31T00:00:00Z",
      docs_url: "https://docs.appaigateway.com/integrate/ios#per-request-proof",
      unsigned_last_seen_at: null,
    }]);

    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = 'warnings-live'")
      .bind(JSON.stringify({ unsigned_requests: { until: "2020-01-31T00:00:00Z" } })).run();
    const expired = await (await admin("warnings-live")).json<{ app: { warnings: unknown[] } }>();
    expect(expired.app.warnings).toEqual([]);
  });

  it("is always present, and refused on a write", async () => {
    await seedApp("warnings-write");
    const { app } = await (await admin("warnings-write")).json<{
      app: { name: string; config: unknown; revision: number; warnings: unknown[] };
    }>();
    expect(app.warnings).toEqual([]);
    const refused = await admin("warnings-write", {
      method: "PUT",
      body: JSON.stringify({ name: app.name, config: app.config, revision: app.revision, warnings: [] }),
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({ error: { message: expect.stringContaining("warnings") } });
    // A write never touches the legacy modes either.
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = 'warnings-write'")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } })).run();
    const updated = await admin("warnings-write", {
      method: "PUT",
      body: JSON.stringify({ name: "Renamed", config: app.config, revision: app.revision }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json<{ app: { warnings: { code: string }[] } }>();
    expect(body.app.warnings.map((warning) => warning.code)).toEqual(["legacy_unsigned_requests"]);
    const stored = await env.DB.prepare("SELECT legacy FROM app WHERE id = 'warnings-write'").first<{ legacy: string }>();
    expect(JSON.parse(stored!.legacy)).toEqual({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } });
  });
});

describe("the last unsigned request", () => {
  it("is recorded at most once an hour, and shown in the warning", async () => {
    const appId = "legacy-last-seen";
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = ?")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } }), appId).run();
    clearIsolateCaches();
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    upstream();
    const seenAt = async () => (await env.DB.prepare("SELECT unsigned_last_seen_at AS at FROM app WHERE id = ?")
      .bind(appId).first<{ at: string | null }>())?.at ?? null;
    expect(await seenAt()).toBeNull();

    expect((await send(await proxied(install, token, { proof: null }))).status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    const first = await seenAt();
    expect(first).not.toBeNull();
    expect(Math.abs(Date.parse(first!) - Date.now())).toBeLessThan(60_000);

    // Within the hour nothing is written, not even by a fresh isolate.
    clearIsolateCaches();
    expect((await send(await proxied(install, token, { proof: null }))).status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    expect(await seenAt()).toBe(first);

    // A signed request is not an unsigned one.
    const stale = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE app SET unsigned_last_seen_at = ? WHERE id = ?").bind(stale, appId).run();
    clearIsolateCaches();
    expect((await send(await proxied(install, token))).status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    expect(await seenAt()).toBe(stale);

    // Past the hour, the next unsigned request moves it.
    expect((await send(await proxied(install, token, { proof: null }))).status).toBe(200);
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    const moved = await seenAt();
    expect(moved! > stale).toBe(true);

    const read = await send(new Request(`${ORIGIN}/v1/admin/apps/${appId}`, {
      headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
    }));
    const { app } = await read.json<{ app: { warnings: { unsigned_last_seen_at: string | null }[] } }>();
    expect(app.warnings[0]?.unsigned_last_seen_at).toBe(moved);
  });
});

describe("disabling a legacy mode", () => {
  const admin = (path: string, init: RequestInit = {}) => send(new Request(`${ORIGIN}/v1/admin/apps/${path}`, {
    ...init,
    headers: {
      authorization: "Bearer agw_mgmt_test-admin-secret",
      "content-type": "application/json",
      ...init.headers,
    },
  }));

  it("ends it at once, answers the app without the warning, and changes nothing the second time", async () => {
    const appId = "legacy-disable";
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = ?")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } }), appId).run();
    clearIsolateCaches();
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    upstream();
    expect((await send(await proxied(install, token, { proof: null }))).status).toBe(200);

    const disabled = await admin(`${appId}/legacy/unsigned_requests/disable`, { method: "POST" });
    expect(disabled.status).toBe(200);
    const body = await disabled.json<{ app: { id: string; warnings: unknown[]; revision: number } }>();
    expect(body.app).toMatchObject({ id: appId, warnings: [], revision: 1 });
    const row = await env.DB.prepare("SELECT legacy FROM app WHERE id = ?").bind(appId).first();
    expect(row).toEqual({ legacy: null });

    // This isolate dropped its cached record, so the very next request is refused.
    const refused = await send(await proxied(install, token, { proof: null }));
    expect(refused.status).toBe(401);
    await expect(errorOf(refused)).resolves.toMatchObject({ code: "assertion_required" });

    const again = await admin(`${appId}/legacy/unsigned_requests/disable`, { method: "POST" });
    expect(again.status).toBe(200);
  });

  it("refuses a mode that does not exist", async () => {
    await seedApp("legacy-disable-unknown");
    const response = await admin("legacy-disable-unknown/legacy/everything/disable", { method: "POST" });
    expect(response.status).toBe(400);
  });

  /** One way: nothing writes a legacy mode, so none can be created or extended. */
  it("is the only write that reaches legacy: app create and update refuse it", async () => {
    await seedApp("legacy-write");
    const { app } = await (await admin("legacy-write")).json<{
      app: { name: string; config: Record<string, unknown>; revision: number };
    }>();
    const legacy = { unsigned_requests: { until: "2099-01-31T00:00:00Z" } };
    for (const body of [
      { name: app.name, config: app.config, revision: app.revision, legacy },
      { name: app.name, config: { ...app.config, legacy }, revision: app.revision },
    ]) {
      const refused = await admin("legacy-write", { method: "PUT", body: JSON.stringify(body) });
      expect(refused.status).toBe(400);
      await expect(errorOf(refused)).resolves.toMatchObject({ message: expect.stringContaining("legacy") });
    }
    for (const body of [
      { name: "New app", config: app.config, legacy },
      { name: "New app", config: { ...app.config, legacy } },
    ]) {
      const refused = await send(new Request(`${ORIGIN}/v1/admin/apps`, {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_test-admin-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(refused.status).toBe(400);
    }
    const row = await env.DB.prepare("SELECT legacy FROM app WHERE id = 'legacy-write'").first();
    expect(row).toEqual({ legacy: null });
  });
});

describe("a failing last-seen write", () => {
  /** The deployment's database, with the last-seen write failing and counted. */
  function failingWrites(counter: { attempts: number }): D1Database {
    return new Proxy(env.DB, {
      get: (target, property, receiver) => property === "prepare"
        ? (query: string) => {
          if (!query.includes("SET unsigned_last_seen_at")) return target.prepare(query);
          counter.attempts += 1;
          return {
            bind: () => ({ run: () => Promise.reject(new Error("D1 is not accepting writes")) }),
          } as unknown as D1PreparedStatement;
        }
        : Reflect.get(target, property, receiver),
    });
  }

  it("leaves the responses alone and is not retried on every request", async () => {
    const appId = "legacy-seen-outage";
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = ?")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } }), appId).run();
    clearIsolateCaches();
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    upstream();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const counter = { attempts: 0 };
    const bindings = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "DB" ? failingWrites(counter) : Reflect.get(target, property, receiver),
    }) as Env;
    for (let index = 0; index < 5; index += 1) {
      expect((await send(await proxied(install, token, { proof: null }), bindings)).status).toBe(200);
    }
    await Promise.all(pending.splice(0).map((context) => waitOnExecutionContext(context)));
    expect(counter.attempts).toBe(1);
  });

  it("backs off five minutes, doubling, and writes again once the backoff has passed", async () => {
    const appId = "legacy-seen-backoff";
    await seedApp(appId);
    clearIsolateCaches();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const counter = { attempts: 0 };
    const db = failingWrites(counter);
    const record = { id: appId, unsignedLastSeenAt: null };
    const start = Date.now();
    const minute = 60_000;
    await noteUnsignedRequest(db, record, start);
    expect(counter.attempts).toBe(1);
    // Inside the first backoff, nothing is tried.
    await noteUnsignedRequest(db, record, start + 1_000);
    await noteUnsignedRequest(db, record, start + 4 * minute);
    expect(counter.attempts).toBe(1);
    // Past it, one more try, which fails and doubles the wait.
    await noteUnsignedRequest(db, record, start + 5 * minute);
    expect(counter.attempts).toBe(2);
    await noteUnsignedRequest(db, record, start + 14 * minute);
    expect(counter.attempts).toBe(2);
    await noteUnsignedRequest(db, record, start + 15 * minute);
    expect(counter.attempts).toBe(3);
    // Once D1 takes writes again, the next try past the backoff lands.
    await noteUnsignedRequest(env.DB, record, start + 35 * minute);
    const row = await env.DB.prepare("SELECT unsigned_last_seen_at AS at FROM app WHERE id = ?")
      .bind(appId).first<{ at: string | null }>();
    expect(row?.at).toBe(new Date(start + 35 * minute).toISOString());
  });
});

describe("the cached app record and a disable that races a read", () => {
  it("never lets a read that began before the disable put the mode back", async () => {
    const appId = "legacy-read-race";
    await seedApp(appId);
    await env.DB.prepare("UPDATE app SET legacy = ? WHERE id = ?")
      .bind(JSON.stringify({ unsigned_requests: { until: "2099-01-31T00:00:00Z" } }), appId).run();
    clearIsolateCaches();
    // A read whose answer is held back until the test releases it, having
    // already been read from D1 with the mode enabled.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let read!: () => void;
    const readDone = new Promise<void>((resolve) => { read = resolve; });
    const held = (value: unknown) => { read(); return gate.then(() => value); };
    const slowDb = new Proxy(env.DB, {
      get: (target, property, receiver) => property === "prepare"
        ? (query: string) => new Proxy(target.prepare(query), {
          get: (statement, name, statementReceiver) => {
            const member = Reflect.get(statement, name, statementReceiver);
            if (name === "bind") {
              return (...values: unknown[]) => new Proxy(statement.bind(...values), {
                get: (bound, method) => {
                  const fn = Reflect.get(bound, method) as unknown;
                  return typeof fn === "function" && ["all", "raw", "first", "run"].includes(String(method))
                    ? (...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>).apply(bound, args).then(held)
                    : typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).bind(bound) : fn;
                },
              });
            }
            return typeof member === "function" && ["all", "raw", "first", "run"].includes(String(name))
              ? (...args: unknown[]) => (member as (...a: unknown[]) => Promise<unknown>).apply(statement, args).then(held)
              : typeof member === "function" ? (member as (...a: unknown[]) => unknown).bind(statement) : member;
          },
        })
        : Reflect.get(target, property, receiver),
    });
    const slow = new Proxy(env, {
      get: (target, property, receiver) => property === "DB" ? slowDb : Reflect.get(target, property, receiver),
    }) as Env;

    const stale = loadApp(slow, appId);
    await readDone;
    // The disable commits and invalidates while that read is still out.
    const disabled = await send(new Request(`${ORIGIN}/v1/admin/apps/${appId}/legacy/unsigned_requests/disable`, {
      method: "POST",
      headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
    }));
    expect(disabled.status).toBe(200);
    release();
    // The read in flight answers what it read...
    expect(legacyMode(await stale, "unsigned_requests")).not.toBeNull();
    // ...but did not cache it: the next request sees the mode gone.
    expect(appConfigCache.peek(appId)).toBeUndefined();
    expect(legacyMode(await loadApp(env, appId), "unsigned_requests")).toBeNull();
  });

  it("measures the cached record's window from the read's start", async () => {
    const appId = "legacy-read-window";
    await seedApp(appId);
    clearIsolateCaches();
    const before = Date.now();
    await loadApp(env, appId);
    const entry = appConfigCache.peek(appId)!;
    expect(entry.storedAt).toBeGreaterThanOrEqual(before);
    expect(entry.storedAt).toBeLessThanOrEqual(Date.now());
    expect(entry.expiresAt - entry.storedAt).toBe(60_000);
  });
});
