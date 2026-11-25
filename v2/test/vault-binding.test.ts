/**
 * The gateway's one interface to the vault (`src/vault/client.ts`), run both
 * through the real `VAULT` service binding (the vault Worker as it is
 * uploaded, `vitest.config.ts`) and as a local call (`test/local-vault.ts`):
 * the two must behave the same.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/core/errors.ts";
import { setVaultForTests, vault, type VaultClient } from "../src/vault/client.ts";
import { localVault } from "./local-vault.ts";

const KEY = "sk-test-binding-key-9876";
const BASE = "https://llm.example.com/proxy/";
const IDENTITY: [string, string, string, string] = ["acct_bind", "conn_bind", "openai", BASE];

/** The binding's client: the test default (the local call) put aside for it. */
function bound(): VaultClient {
  setVaultForTests(null);
  try {
    return vault(env);
  } finally {
    setVaultForTests(localVault);
  }
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["through the binding", bound],
  ["as a local call", () => localVault(env)],
])("the vault %s", (_name, client) => {
  it("seals, sends with the key, and passes the answer back without the key header", async () => {
    const vaultClient = client();
    const blob = await vaultClient.seal("providerKey", IDENTITY, KEY);
    expect(blob).toMatch(/^local1\./u);
    // The local call sends from this Worker; the binding's vault answers with its echo stand-in.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      return Response.json({ url: String(input), headers: Object.fromEntries(headers) }, { headers: { authorization: headers.get("authorization") ?? "" } });
    });
    const response = await vaultClient.call({
      url: `${BASE}v1/chat/completions`,
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{}",
      credentials: { providerKey: { blob, identity: IDENTITY, header: "authorization", format: "Bearer {key}" } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("authorization")).toBeNull();
    const seen = (await response.json()) as { url: string; headers: Record<string, string> };
    expect(seen.url).toBe(`${BASE}v1/chat/completions`);
    expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen.headers["x-agw-vault"]).toBeUndefined();
  });

  it("refuses a call to another address as a 502 provider_unavailable", async () => {
    const vaultClient = client();
    const blob = await vaultClient.seal("providerKey", IDENTITY, KEY);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const call = vaultClient.call({
      url: "https://evil.test/v1",
      method: "POST",
      headers: new Headers(),
      body: "{}",
      credentials: { providerKey: { blob, identity: IDENTITY, header: "authorization", format: "Bearer {key}" } },
    });
    await expect(call).rejects.toBeInstanceOf(GatewayError);
    await expect(call).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says which texts echo the key, and only yes or no", async () => {
    const vaultClient = client();
    const blob = await vaultClient.seal("providerKey", IDENTITY, KEY);
    const credentials = { providerKey: { blob, identity: IDENTITY, header: "authorization", format: "Bearer {key}" } };
    expect(await vaultClient.holds(credentials, [`bad header: Bearer ${KEY}`, "nothing here", ""])).toEqual([true, false, false]);
  });

  it("re-seals for a new address without returning the key", async () => {
    const vaultClient = client();
    const blob = await vaultClient.seal("providerKey", IDENTITY, KEY);
    const moved = await vaultClient.reseal("providerKey", IDENTITY, ["acct_bind", "conn_bind", "openai", ""], blob);
    expect(moved).toMatch(/^local1\./u);
    expect(moved).not.toContain(KEY);
  });
});
