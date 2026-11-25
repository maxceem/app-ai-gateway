/**
 * The vault Worker's own rules (`v2/vault/src/`, plan step 8i): a key goes
 * only to the address it is sealed for, the vault's host table matches the
 * provider descriptions, its contexts match the gateway's, and an answer
 * never carries the key header back.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedUrl, callProvider, under, VAULT_ERROR_HEADER } from "../vault/src/call.js";
import { PROVIDER_HOSTS } from "../vault/src/hosts.js";
import { CONTEXT_NAMES, open, reseal, seal, secretContext as vaultContext } from "../vault/src/seal.js";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { keyOrigin } from "../src/providers/connections.ts";
import { openSecret, sealSecret, secretContext, SECRET_KINDS, secretIdentityLength } from "../src/vault/secrets.ts";

const vaultEnv = env as unknown as Record<string, unknown>;
const KEY = "sk-test-vault-key-1234";

afterEach(() => vi.restoreAllMocks());

/** A sealed provider key's call credentials, for `identity` and the key's header. */
async function providerKey(identity: [string, string, string, string]) {
  return { providerKey: { blob: await seal(vaultEnv, "providerKey", identity, KEY), identity, header: "authorization", format: "Bearer {key}" } };
}

describe("where a key may go", () => {
  it("keeps a call under the address the key is sealed for, as written and once parsed", () => {
    const base = "https://llm.example.com/proxy/";
    expect(under(`${base}v1/chat/completions?x=1`, base)).toBe(`${base}v1/chat/completions?x=1`);
    // Another host, a user part, or a path that climbs out of the base: refused.
    for (const url of [
      "https://llm.example.com.evil.test/proxy/v1",
      "https://llm.example.com@evil.test/proxy/v1",
      "https://user@llm.example.com/proxy/v1",
      `${base}../admin`,
      `${base}%2e%2e/admin`,
      `${base}v1/%2E/x`,
      `${base}..\\admin`,
      `${base}v1\\..\\..\\admin`,
      "http://llm.example.com/proxy/v1",
      "https://llm.example.com/other/v1",
    ]) {
      expect(under(url, base), url).toBeNull();
    }
    // A double slash stays on the same host and under the base: the host can never change.
    expect(new URL(under(`${base}/evil.test/x`, base)!).host).toBe("llm.example.com");
  });

  it("sends a key sealed for the provider's own address only to that provider type's hosts", () => {
    const credentials = (type: string) => ({ providerKey: { blob: "b", identity: ["a", "c", type, ""], header: "authorization", format: "Bearer {key}" } });
    expect(allowedUrl("https://queue.fal.run/fal-ai/x", credentials("fal"))).toBe("https://queue.fal.run/fal-ai/x");
    expect(allowedUrl("https://fal.run/fal-ai/x", credentials("fal"))).toBe("https://fal.run/fal-ai/x");
    expect(allowedUrl("https://openrouter.ai/api/v1/chat/completions", credentials("openrouter"))).not.toBeNull();
    // OpenRouter's key goes under its API path only, never elsewhere on its host.
    expect(allowedUrl("https://openrouter.ai/settings/keys", credentials("openrouter"))).toBeNull();
    expect(allowedUrl("https://api.openai.com/v1/x", credentials("fal"))).toBeNull();
    expect(allowedUrl("https://api.openai.com@evil.test/v1/x", credentials("openai"))).toBeNull();
    // A dot segment is refused even where it would land on the same host: servers read them differently.
    expect(allowedUrl("https://api.openai.com/v1/../../x", credentials("openai"))).toBeNull();
    // A type the table does not list, such as a custom provider, has no own hosts.
    expect(allowedUrl("https://api.openai.com/v1/x", credentials("custom"))).toBeNull();
    expect(allowedUrl("https://api.openai.com/v1/x", credentials("__proto__"))).toBeNull();
  });

  it("sends a Cloudflare token only under the account and gateway it is sealed for, and both credentials must agree", () => {
    const token = { blob: "t", identity: ["a", "c", "cf-acct", "cf-gw"] };
    const gateway = "https://gateway.ai.cloudflare.com/v1/cf-acct/cf-gw/";
    expect(allowedUrl(`${gateway}openai/chat/completions`, { cloudflareToken: token })).toBe(`${gateway}openai/chat/completions`);
    expect(allowedUrl("https://gateway.ai.cloudflare.com/v1/cf-acct/other/openai", { cloudflareToken: token })).toBeNull();
    expect(allowedUrl(`${gateway}../other/openai`, { cloudflareToken: token })).toBeNull();
    // A provider key sealed for the same gateway goes with it; one sealed for the provider's own host does not.
    const key = { blob: "k", identity: ["a", "c", "openai", gateway], header: "authorization", format: "Bearer {key}" };
    expect(allowedUrl(`${gateway}openai/x`, { cloudflareToken: token, providerKey: key })).toBe(`${gateway}openai/x`);
    expect(allowedUrl(`${gateway}openai/x`, { cloudflareToken: token, providerKey: { ...key, identity: ["a", "c", "openai", ""] } })).toBeNull();
    expect(allowedUrl(`${gateway}openai/x`, {})).toBeNull();
  });

  it("seals a base URL that is exactly one of the provider's own hosts for the provider's own address", () => {
    expect(keyOrigin({ type: "fal", baseUrl: "https://queue.fal.run/", cloudflareGateway: null })).toBe("");
    expect(keyOrigin({ type: "openrouter", baseUrl: "https://openrouter.ai/api/", cloudflareGateway: null })).toBe("");
    // A regional or other declared host stays a custom address, sealed under itself.
    expect(keyOrigin({ type: "mistral", baseUrl: "https://api.eu.mistral.ai/", cloudflareGateway: null })).toBe("https://api.eu.mistral.ai/");
    expect(keyOrigin({ type: "custom", baseUrl: "https://api.openai.com/", cloudflareGateway: null })).toBe("https://api.openai.com/");
  });
});

describe("the vault's tables", () => {
  it("names exactly the provider descriptions' own hosts", () => {
    const declared = Object.fromEntries(
      Object.values(BUILT_IN_PROVIDERS).map((provider) => [provider.type, [...new Set(Object.values(provider.hosts))].sort()]),
    );
    const table = Object.fromEntries(Object.entries(PROVIDER_HOSTS).map(([type, hosts]) => [type, [...hosts].sort()]));
    expect(table).toEqual(declared);
  });

  it("seals and opens under the same contexts as the gateway", async () => {
    expect(Object.keys(CONTEXT_NAMES).sort()).toEqual([...SECRET_KINDS].sort());
    for (const kind of SECRET_KINDS) {
      const identity = Array.from({ length: secretIdentityLength(kind) }, (_, index) => `id-${index}`);
      expect(vaultContext(kind, identity)).toEqual(secretContext(kind, identity as never));
      // A blob either side seals opens on the other.
      expect(await openSecret(env, kind, identity as never, await seal(vaultEnv, kind, identity, "s1"))).toBe("s1");
      expect(await open(vaultEnv, kind, identity, await sealSecret(env, kind, identity as never, "s2"))).toBe("s2");
    }
  });

  it("opens a blob only under the identity it is sealed to, and re-seals without returning the key", async () => {
    const from: [string, string, string, string] = ["a", "c", "openai", "https://llm.example.com/"];
    const to: [string, string, string, string] = ["a", "c", "openai", ""];
    const blob = await seal(vaultEnv, "providerKey", from, KEY);
    await expect(open(vaultEnv, "providerKey", to, blob)).rejects.toThrow(/does not open/u);
    await expect(open(vaultEnv, "providerKey", ["a", "other", "openai", from[3]], blob)).rejects.toThrow(/does not open/u);
    const moved = await reseal(vaultEnv, "providerKey", from, to, blob);
    expect(await open(vaultEnv, "providerKey", to, moved)).toBe(KEY);
  });
});

describe("a call", () => {
  it("adds the key, never follows a redirect, and never passes the key header back", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      return new Response("moved", { status: 302, headers: { location: "https://evil.test/", authorization: headers.get("authorization") ?? "" } });
    });
    const response = await callProvider(vaultEnv, {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: new Headers({ "x-agw-vault": "{}", "content-type": "application/json" }),
      body: null,
      credentials: await providerKey(["a", "c", "openai", ""]),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("authorization")).toBeNull();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(new Headers(init?.headers).has("x-agw-vault")).toBe(false);
  });

  it("refuses, sending nothing, a call to another address or with a key that does not open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sealed = await providerKey(["a", "c", "openai", ""]);
    const elsewhere = await callProvider(vaultEnv, { url: "https://evil.test/v1", method: "POST", headers: new Headers(), body: "{}", credentials: sealed });
    expect(elsewhere.headers.get(VAULT_ERROR_HEADER)).toBe("destination_refused");
    const broken = { providerKey: { ...sealed.providerKey, identity: ["a", "other", "openai", ""] } };
    const unopened = await callProvider(vaultEnv, { url: "https://api.openai.com/v1", method: "POST", headers: new Headers(), body: "{}", credentials: broken });
    expect(unopened.headers.get(VAULT_ERROR_HEADER)).toBe("credential_unavailable");
    const malformed = await callProvider(vaultEnv, {
      url: "https://api.openai.com/v1",
      method: "POST",
      headers: new Headers(),
      body: "{}",
      credentials: { providerKey: { ...sealed.providerKey, format: "no placeholder" } },
    });
    expect(malformed.headers.get(VAULT_ERROR_HEADER)).toBe("bad_request");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
