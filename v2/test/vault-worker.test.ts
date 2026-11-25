/**
 * The vault Worker's own rules (`v2/vault/src/`, plan step 8i): a key goes
 * only to the address it is sealed for, the vault's host table matches the
 * provider descriptions, its contexts match the gateway's, and an answer
 * never carries the key header back.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedUrl, callProvider, holds, keyHeaderAllowed, readCredentials, under, VAULT_ERROR_HEADER } from "../vault/src/call.js";
import { CLOUDFLARE_SLUGS, KEY_HEADERS, PROVIDER_HOSTS } from "../vault/src/hosts.js";
import { CONTEXT_NAMES, open, reseal, seal, secretContext as vaultContext } from "../vault/src/seal.js";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { keyOrigin } from "../src/providers/connections.ts";
import { openSecret, sealSecret, secretContext, SECRET_KINDS, secretIdentityLength } from "../src/vault/secrets.ts";

const vaultEnv = env as unknown as Record<string, unknown>;
const KEY = "sk-test-vault-key-1234";

afterEach(() => vi.restoreAllMocks());

/**
 * A sealed provider key's call credentials. A built-in type's is placed in
 * `authorization`; a custom one is sealed with that placement.
 */
async function providerKey(ids: [string, string, string, string]) {
  const identity = [...ids, ...(ids[2] === "custom" ? ["authorization", "Bearer {key}"] : ["", ""])];
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
    const credentials = (type: string) => ({ providerKey: { blob: "b", identity: ["a", "c", type, "", "", ""], header: "authorization", format: "Bearer {key}" } });
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
    const key = { blob: "k", identity: ["a", "c", "openai", gateway, "", ""], header: "authorization", format: "Bearer {key}" };
    expect(allowedUrl(`${gateway}openai/x`, { cloudflareToken: token, providerKey: key })).toBe(`${gateway}openai/x`);
    expect(allowedUrl(`${gateway}openai/x`, { cloudflareToken: token, providerKey: { ...key, identity: ["a", "c", "openai", "", "", ""] } })).toBeNull();
    expect(allowedUrl(`${gateway}openai/x`, {})).toBeNull();
  });

  it("sends a key sealed for a Cloudflare AI Gateway only under its own provider's path there", () => {
    const gateway = "https://gateway.ai.cloudflare.com/v1/cf-acct/cf-gw/";
    const key = (type: string) => ({ blob: "k", identity: ["a", "c", type, gateway, "", ""], header: "authorization", format: "Bearer {key}" });
    expect(allowedUrl(`${gateway}openai/chat/completions`, { providerKey: key("openai") })).toBe(`${gateway}openai/chat/completions`);
    // AI Gateway passes `/fal/...` on to fal: an OpenAI key never goes there.
    expect(allowedUrl(`${gateway}fal/fal-ai/flux`, { providerKey: key("openai") })).toBeNull();
    expect(allowedUrl(`${gateway}google-ai-studio/v1beta/models`, { providerKey: key("openai") })).toBeNull();
    // A type with no AI Gateway path is never sent through it.
    expect(allowedUrl(`${gateway}fal/fal-ai/flux`, { providerKey: key("fal") })).toBeNull();
    expect(allowedUrl(`${gateway}google-ai-studio/v1beta/models`, { providerKey: { ...key("gemini"), header: "x-goog-api-key", format: "{key}" } })).not.toBeNull();
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

  it("takes each built-in type's key only in the headers its own description uses for keys", () => {
    const declared = Object.fromEntries(
      Object.values(BUILT_IN_PROVIDERS).map((provider) => {
        const headers = new Set([provider.auth.header.toLowerCase()]);
        for (const auth of Object.values(provider.cloudflareGateway?.authByStyle ?? {})) headers.add(auth!.header.toLowerCase());
        return [provider.type, [...headers].sort()];
      }),
    );
    const table = Object.fromEntries(Object.entries(KEY_HEADERS).map(([type, headers]) => [type, [...headers].sort()]));
    expect(table).toEqual(declared);
    // fal runs other people's apps and passes other headers on: its key goes only in `authorization`.
    expect(keyHeaderAllowed("fal", "authorization")).toBe(true);
    expect(keyHeaderAllowed("fal", "x-api-key")).toBe(false);
    expect(keyHeaderAllowed("gemini", "authorization")).toBe(false);
  });

  it("names each built-in type's Cloudflare AI Gateway path as its description does", () => {
    const declared = Object.fromEntries(
      Object.values(BUILT_IN_PROVIDERS).flatMap((provider) => (provider.cloudflareGateway === undefined ? [] : [[provider.type, provider.cloudflareGateway.slug]])),
    );
    expect({ ...CLOUDFLARE_SLUGS }).toEqual(declared);
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
    const from = ["a", "c", "openai", "https://llm.example.com/", "", ""];
    const to = ["a", "c", "openai", "", "", ""];
    const blob = await seal(vaultEnv, "providerKey", from, KEY);
    await expect(open(vaultEnv, "providerKey", to, blob)).rejects.toThrow(/does not open/u);
    await expect(open(vaultEnv, "providerKey", ["a", "other", "openai", from[3]!, "", ""], blob)).rejects.toThrow(/does not open/u);
    const moved = await reseal(vaultEnv, "providerKey", from, to, blob);
    expect(await open(vaultEnv, "providerKey", to, moved)).toBe(KEY);
    // A Cloudflare token is never sealed again.
    const tokenIdentity = ["a", "c", "cf-acct", "cf-gw"];
    const token = await seal(vaultEnv, "cloudflareGatewayToken", tokenIdentity, "cf-token-abcdefgh");
    await expect(reseal(vaultEnv, "cloudflareGatewayToken", tokenIdentity, tokenIdentity, token)).rejects.toThrow();
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

  it("sends a custom provider's key only in the header sealed with it, whatever the caller names", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const identity = ["a", "c", "custom", "https://llm.example.com/", "x-my-key", "Key {key}"];
    const blob = await seal(vaultEnv, "providerKey", identity, KEY);
    // The caller asks for a header a proxy could reflect back: the vault uses only the sealed one.
    const sent = await callProvider(vaultEnv, {
      url: "https://llm.example.com/v1",
      method: "GET",
      headers: new Headers(),
      body: null,
      credentials: { providerKey: { blob, identity, header: "x-forwarded-host", format: "{key}" } },
    });
    expect(sent.status).toBe(200);
    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers);
    expect(headers.get("x-my-key")).toBe(`Key ${KEY}`);
    expect(headers.has("x-forwarded-host")).toBe(false);
    // Another placement in the identity does not open the blob.
    const moved = await callProvider(vaultEnv, {
      url: "https://llm.example.com/v1",
      method: "GET",
      headers: new Headers(),
      body: null,
      credentials: { providerKey: { blob, identity: ["a", "c", "custom", "https://llm.example.com/", "x-forwarded-host", "{key}"] } },
    });
    expect(moved.headers.get(VAULT_ERROR_HEADER)).toBe("credential_unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never serves a key opened under one address for a call that names another, with the same blob", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const sealed = await providerKey(["a", "c", "custom", "https://first.example.com/"]);
    // Opened properly first, so it is in the vault's cache.
    expect((await callProvider(vaultEnv, { url: "https://first.example.com/v1", method: "GET", headers: new Headers(), body: null, credentials: sealed })).status).toBe(200);
    // The same blob, under another address it was never sealed for, with a URL that matches that address.
    const moved = { providerKey: { ...sealed.providerKey, identity: ["a", "c", "custom", "https://evil.example.com/", "authorization", "Bearer {key}"] } };
    const answer = await callProvider(vaultEnv, { url: "https://evil.example.com/v1", method: "GET", headers: new Headers(), body: null, credentials: moved });
    expect(answer.headers.get(VAULT_ERROR_HEADER)).toBe("credential_unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never passes an echoed Cloudflare token back", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      new Response("ok", { headers: { "cf-aig-authorization": new Headers(init?.headers).get("cf-aig-authorization") ?? "" } }));
    const identity = ["a", "c", "cf-acct", "cf-gw"];
    const cloudflareToken = { blob: await seal(vaultEnv, "cloudflareGatewayToken", identity, "cf-token-abcdefgh"), identity };
    const answer = await callProvider(vaultEnv, {
      url: "https://gateway.ai.cloudflare.com/v1/cf-acct/cf-gw/openai/chat/completions",
      method: "POST",
      headers: new Headers(),
      body: "{}",
      credentials: { cloudflareToken },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cf-aig-authorization")).toBeNull();
  });

  it("answers `holds` only for well-formed credentials that open under their own identity", async () => {
    const sealed = await providerKey(["a", "c", "openai", ""]);
    expect(await holds(vaultEnv, sealed, [`x ${KEY} y`, "no"])).toEqual([true, false]);
    const tampered = { providerKey: { ...sealed.providerKey, identity: ["a", "other", "openai", "", "", ""] } };
    await expect(holds(vaultEnv, tampered, [KEY])).rejects.toThrow();
    await expect(holds(vaultEnv, { providerKey: { blob: 1 } }, [KEY])).rejects.toThrow();
    await expect(holds(vaultEnv, sealed, [1])).rejects.toThrow();
    expect(readCredentials({})).toBeNull();
  });

  it("refuses, sending nothing, a call to another address or with a key that does not open", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sealed = await providerKey(["a", "c", "openai", ""]);
    const elsewhere = await callProvider(vaultEnv, { url: "https://evil.test/v1", method: "POST", headers: new Headers(), body: "{}", credentials: sealed });
    expect(elsewhere.headers.get(VAULT_ERROR_HEADER)).toBe("destination_refused");
    const broken = { providerKey: { ...sealed.providerKey, identity: ["a", "other", "openai", "", "", ""] } };
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
