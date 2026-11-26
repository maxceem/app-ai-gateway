/**
 * Split keys, phase 1 (plan step 8j): the crypto core in the vault, its
 * storage, and the request path for an app key. The other files that touch
 * provider keys run again with split keys on (`vitest.config.ts`); this one
 * checks what only split keys do.
 */
import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { hashApiKey } from "../src/client-auth/api-keys.ts";
import { KeyShare } from "../src/vault/key-share.ts";
import { OPEN_WORK_HANDLERS, runSweep } from "../src/ledger/sweep.ts";
import { AEAD, decap, deriveKeyPair, encap, keySchedule, openBase, sealBase } from "../vault/src/hpke.js";
import { MAX_STORED_COPY_MS, storeCopy } from "../vault/src/call.js";
import { forgetOpenedKeys, keyForRequest } from "../vault/src/keys.js";
import { additionalData, open, reseal, seal, sealAs, secretContext } from "../vault/src/seal.js";
import { SPLIT_PREFIX, credentialPublicKey, isSplit, newRoot, openRootWithCredential, sealRootToCredential } from "../vault/src/split.js";
import { ACCOUNT_ID, attestAuthentication, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, ledger, loadManagement, registerTestInstall, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp, tokenForInstall } from "./helpers.ts";
import { TEST_VAULT_ENV } from "./local-vault.ts";
import { enableSplitKeys, hasSplitKeys, sealForTest } from "./split-keys.ts";

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * RFC 9180's base-mode vectors for DHKEM(X25519, HKDF-SHA256) and
 * HKDF-SHA256: appendix A.1 (AES-128-GCM), and the CFRG set's case for
 * AES-256-GCM, the suite split keys use. Sequence number 0.
 */
const VECTORS = [
  {
    name: "RFC 9180 A.1, AES-128-GCM",
    aead: AEAD.aes128gcm,
    info: "4f6465206f6e2061204772656369616e2055726e",
    ikmE: "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
    pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
    skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
    ikmR: "6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037",
    pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
    skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
    sharedSecret: "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc",
    key: "4531685d41d65f03dc48f6b8302c05b0",
    baseNonce: "56d890e5accaaf011cff4b7d",
    aad: "436f756e742d30",
    pt: "4265617574792069732074727574682c20747275746820626561757479",
    ct: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
  },
  {
    name: "CFRG vectors, AES-256-GCM",
    aead: AEAD.aes256gcm,
    info: "4f6465206f6e2061204772656369616e2055726e",
    ikmE: "2cd7c601cefb3d42a62b04b7a9041494c06c7843818e0ce28a8f704ae7ab20f9",
    pkEm: "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    skEm: "179d4b53b6365c45b600c4163b61d95cbc2f4d9e36f1695558dce265ab8bab11",
    ikmR: "dac33b0e9db1b59dbbea58d59a14e7b5896e9bdf98fad6891e99d1686492b9ee",
    pkRm: "430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c",
    skRm: "497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d",
    sharedSecret: "3101c54c3a4f87439eaac080699ed9bbcc726ffe44e860c0424ccb7e3e2ead7b",
    key: "f50b0609186798729ed0564b36ef2ef8044f1f9d05636874d1f46c819c7a669f",
    baseNonce: "151d9929e2449747889bc923",
    aad: "436f756e742d30",
    pt: "4265617574792069732074727574682c20747275746820626561757479",
    ct: "e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a",
  },
];

describe("HPKE (RFC 9180), base mode", () => {
  it.each(VECTORS)("matches $name", async (vector) => {
    const sender = await deriveKeyPair(hex(vector.ikmE));
    expect(toHex(sender.privateKey)).toBe(vector.skEm);
    expect(toHex(sender.publicKey)).toBe(vector.pkEm);
    const recipient = await deriveKeyPair(hex(vector.ikmR));
    expect(toHex(recipient.privateKey)).toBe(vector.skRm);
    expect(toHex(recipient.publicKey)).toBe(vector.pkRm);

    const { sharedSecret, enc } = await encap(hex(vector.pkRm), hex(vector.ikmE));
    expect(toHex(enc)).toBe(vector.pkEm);
    expect(toHex(sharedSecret)).toBe(vector.sharedSecret);
    expect(toHex(await decap(enc, hex(vector.skRm)))).toBe(vector.sharedSecret);
    const schedule = await keySchedule(vector.aead, sharedSecret, hex(vector.info));
    expect(toHex(schedule.key)).toBe(vector.key);
    expect(toHex(schedule.baseNonce)).toBe(vector.baseNonce);

    const sealed = await sealBase({ publicKey: hex(vector.pkRm), info: hex(vector.info), aad: hex(vector.aad), plaintext: hex(vector.pt), aead: vector.aead, ikmE: hex(vector.ikmE) });
    expect(toHex(sealed.ciphertext)).toBe(vector.ct);
    const opened = await openBase({ privateKey: hex(vector.skRm), enc: hex(vector.pkEm), info: hex(vector.info), aad: hex(vector.aad), ciphertext: hex(vector.ct), aead: vector.aead });
    expect(toHex(opened)).toBe(vector.pt);
  });

  it("refuses a message under other additional data, other info, or another key", async () => {
    const recipient = await deriveKeyPair(crypto.getRandomValues(new Uint8Array(32)));
    const other = await deriveKeyPair(crypto.getRandomValues(new Uint8Array(32)));
    const info = new TextEncoder().encode("info");
    const aad = new TextEncoder().encode("aad");
    const { enc, ciphertext } = await sealBase({ publicKey: recipient.publicKey, info, aad, plaintext: new TextEncoder().encode("hello") });
    await expect(openBase({ privateKey: recipient.privateKey, enc, info, aad, ciphertext })).resolves.toEqual(new TextEncoder().encode("hello"));
    await expect(openBase({ privateKey: recipient.privateKey, enc, info, aad: new TextEncoder().encode("aae"), ciphertext })).rejects.toThrow();
    await expect(openBase({ privateKey: recipient.privateKey, enc, info: new TextEncoder().encode("infp"), aad, ciphertext })).rejects.toThrow();
    await expect(openBase({ privateKey: other.privateKey, enc, info, aad, ciphertext })).rejects.toThrow();
  });
});

describe("a credential's key pair", () => {
  it("comes from the secret alone, and never from the hash the database keeps", async () => {
    const secret = "agw_credential_one";
    expect(await credentialPublicKey(secret)).toBe(await credentialPublicKey(secret));
    expect(await credentialPublicKey(secret)).not.toBe(await credentialPublicKey("agw_credential_two"));
    // The auth hash, used as a secret, leads to another key: a copy of the database gives no keyslot's key.
    expect(await credentialPublicKey(await hashApiKey(secret))).not.toBe(await credentialPublicKey(secret));
  });
});

const ACCOUNT = "acct_split";
const SLOT_IDENTITY = [ACCOUNT, "key_1", "api_key"];
const IDENTITY: [string, string, string, string, string, string] = [ACCOUNT, "conn_1", "openai", "", "", ""];
const PROVIDER_KEY = "sk-provider-split-1234";
const APP_SECRET = "agw_app_key_secret";

/** A split-key account in the vault alone: a root, a provider key sealed to it, and one app key's keyslot. */
async function splitAccount(account = ACCOUNT) {
  const root = await newRoot();
  const identity: [string, string, string, string, string, string] = [account, "conn_1", "openai", "", "", ""];
  const slotIdentity = [account, "key_1", "api_key"];
  const blob = await seal(TEST_VAULT_ENV, "providerKey", identity, PROVIDER_KEY, root.publicKey);
  const inner = await sealRootToCredential(root.privateKey, await credentialPublicKey(APP_SECRET), additionalData(secretContext("keySlot", slotIdentity)));
  const slot = await sealAs(TEST_VAULT_ENV, "keySlot", slotIdentity, inner);
  return { root, identity, blob, slot, credential: { secret: APP_SECRET, slot, slotIdentity } };
}

describe("the vault with split keys", () => {
  beforeEach(() => forgetOpenedKeys());

  it("seals a key to the root inside the KEK: the KEK alone opens only the sealed value", async () => {
    const { blob } = await splitAccount();
    const kekLayer = await open(TEST_VAULT_ENV, "providerKey", IDENTITY, blob);
    expect(isSplit(kekLayer)).toBe(true);
    expect(kekLayer).not.toContain(PROVIDER_KEY);
  });

  it("opens a key only with the credential the request brought", async () => {
    const { blob, credential } = await splitAccount();
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob, { credential })).resolves.toBe(PROVIDER_KEY);
    forgetOpenedKeys();
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob)).rejects.toThrow(/credential/u);
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob, { credential: { ...credential, secret: "agw_wrong" } })).rejects.toThrow();
  });

  it("never serves an opened key from its cache to a request without that credential", async () => {
    const { blob, credential } = await splitAccount();
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob, { credential })).resolves.toBe(PROVIDER_KEY);
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob)).rejects.toThrow();
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob, { credential: { ...credential, secret: "agw_wrong" } })).rejects.toThrow();
    // The right one is still served, from the cache or not.
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, blob, { credential })).resolves.toBe(PROVIDER_KEY);
  });

  it("never opens one account's key with another account's keyslot", async () => {
    const mine = await splitAccount();
    const theirs = await splitAccount("acct_other");
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, mine.blob, { credential: theirs.credential })).rejects.toThrow(/another account/u);
    // Nor a keyslot relabelled as this account's: its seal is bound to the account it was made for.
    await expect(
      keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, mine.blob, { credential: { ...theirs.credential, slotIdentity: SLOT_IDENTITY } }),
    ).rejects.toThrow();
  });

  it("never opens a key sealed for one connection or address under another", async () => {
    const { blob, credential } = await splitAccount();
    const elsewhere: [string, string, string, string, string, string] = [ACCOUNT, "conn_1", "openai", "https://elsewhere.example/", "", ""];
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", elsewhere, blob, { credential })).rejects.toThrow();
  });

  it("opens a key saved without split keys as before, with or without a credential", async () => {
    const { credential } = await splitAccount();
    const plain = await seal(TEST_VAULT_ENV, "providerKey", IDENTITY, PROVIDER_KEY);
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, plain)).resolves.toBe(PROVIDER_KEY);
    await expect(keyForRequest(TEST_VAULT_ENV, "providerKey", IDENTITY, plain, { credential })).resolves.toBe(PROVIDER_KEY);
  });

  it("refuses to seal a key that looks like a sealed value, and never moves a split key without the key", async () => {
    const { blob } = await splitAccount();
    await expect(seal(TEST_VAULT_ENV, "providerKey", IDENTITY, `${SPLIT_PREFIX}abc.def`)).rejects.toThrow();
    await expect(reseal(TEST_VAULT_ENV, "providerKey", IDENTITY, IDENTITY, blob)).rejects.toThrow(/needs the key again/u);
    // The gateway seals only provider keys and tokens: never a keyslot or a stored copy.
    await expect(seal(TEST_VAULT_ENV, "keySlot", SLOT_IDENTITY, "x")).rejects.toThrow();
  });

  it("opens the root from a keyslot only with the credential's own secret", async () => {
    const { root, slot } = await splitAccount();
    const inner = await open(TEST_VAULT_ENV, "keySlot", SLOT_IDENTITY, slot);
    const aad = additionalData(secretContext("keySlot", SLOT_IDENTITY));
    expect(await openRootWithCredential(APP_SECRET, aad, inner)).toEqual(root.privateKey);
    await expect(openRootWithCredential("agw_wrong", aad, inner)).rejects.toThrow();
  });
});

describe("stored copies for work with no app request", () => {
  beforeEach(() => forgetOpenedKeys());
  afterEach(() => vi.useRealTimers());

  it("opens without a credential until it expires, and never after", async () => {
    const { blob, credential } = await splitAccount();
    const expiresAt = Date.now() + 60 * 60_000;
    const copies = await storeCopy(TEST_VAULT_ENV, { providerKey: { blob, identity: IDENTITY }, credential }, expiresAt);
    const copy = copies.providerKey!;
    expect(copy.identity).toEqual([...IDENTITY, String(expiresAt)]);
    await expect(keyForRequest(TEST_VAULT_ENV, "storedProviderKey", copy.identity, copy.blob)).resolves.toBe(PROVIDER_KEY);
    // Bound to its expiry: a later one written over it does not open.
    await expect(keyForRequest(TEST_VAULT_ENV, "storedProviderKey", [...IDENTITY, String(expiresAt + 3_600_000)], copy.blob)).rejects.toThrow();
    // Checked before the cache, so a copy never outlives its own time.
    vi.useFakeTimers({ toFake: ["Date"], now: expiresAt + 1 });
    await expect(keyForRequest(TEST_VAULT_ENV, "storedProviderKey", copy.identity, copy.blob)).rejects.toThrow(/expired/u);
  });

  it("is made only with the app's credential, for at most 3 hours, and never from another copy", async () => {
    const { blob, credential } = await splitAccount();
    const providerKey = { blob, identity: IDENTITY };
    await expect(storeCopy(TEST_VAULT_ENV, { providerKey }, Date.now() + 60_000)).rejects.toThrow();
    await expect(storeCopy(TEST_VAULT_ENV, { providerKey, credential }, Date.now() + MAX_STORED_COPY_MS + 60_000)).rejects.toThrow(/3 hours/u);
    await expect(storeCopy(TEST_VAULT_ENV, { providerKey, credential }, Date.now() - 1)).rejects.toThrow();
    const copy = (await storeCopy(TEST_VAULT_ENV, { providerKey, credential }, Date.now() + 60_000)).providerKey!;
    await expect(storeCopy(TEST_VAULT_ENV, { providerKey: copy, credential }, Date.now() + 60_000)).rejects.toThrow(/never copied again/u);
  });
});

describe("the key share", () => {
  it("never prints its secret", () => {
    const share = new KeyShare("agw_super_secret_value", { blob: "local1.x", identity: [ACCOUNT, "key_1", "api_key"] });
    expect(JSON.stringify({ share })).not.toContain("agw_super_secret_value");
    expect(String(share)).not.toContain("agw_super_secret_value");
    expect({ ...share }).not.toHaveProperty("secret");
    expect(share.forVault().secret).toBe("agw_super_secret_value");
  });
});

// ---------------------------------------------------------------------------
// Through the gateway, for the test account with split keys on.

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-split-provider-key";

async function seedSplitConnection(type = "openai"): Promise<{ id: string; slug: string }> {
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealForTest("providerKey", [ACCOUNT_ID, id, type, "", "", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '-key', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, now, now)
    .run();
  return { id, slug };
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await response.clone().text();
  await waitOnExecutionContext(ctx);
  return response;
}

function chat(authorization: string, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...extra },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
  };
}

async function admin(key: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

let fetchSpy: MockInstance<typeof fetch>;

describe("requests for an account with split keys on", () => {
  beforeAll(async () => {
    // The management code loads slowly on its first request.
    await loadManagement();
    await seedAccount();
    if (!hasSplitKeys(ACCOUNT_ID)) await enableSplitKeys(ACCOUNT_ID);
  }, LOAD_MANAGEMENT_TIMEOUT_MS);

  beforeEach(() => {
    clearCaches();
    forgetOpenedKeys();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => vi.restoreAllMocks());

  async function app(slug: string, operations = ["openai.chat"]) {
    const appId = await seedRoutedApp({ type: "api_key", end_user: { source: "none" } }, { providers: { [slug]: { operations } } });
    return { appId, key: await seedAppKey(appId) };
  }

  it("sends the provider key for a request whose app key has a keyslot", async () => {
    const { slug } = await seedSplitConnection();
    const { appId, key } = await app(slug);
    fetchSpy.mockResolvedValue(Response.json({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const response = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chat(`Bearer ${key.key}`));
    expect(response.status).toBe(200);
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("sends nothing for an app key with no keyslot: its account's keys do not open", async () => {
    const { slug } = await seedSplitConnection();
    const { appId, key } = await app(slug);
    await env.DB.prepare("DELETE FROM key_slot WHERE credential_id = ?").bind(key.id).run();
    clearCaches();
    const response = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chat(`Bearer ${key.key}`));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing for a gateway token until tokens carry a share (phase 3)", async () => {
    const { slug } = await seedSplitConnection();
    const appId = await seedRoutedApp(attestAuthentication({ verify_on: "token_exchange" }), { providers: { [slug]: { operations: ["openai.chat"] } } });
    const install = await registerTestInstall(appId);
    const response = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chat(`Bearer ${await tokenForInstall(install)}`, { "x-app-version": "1.0" }));
    expect(response.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("seals a key saved through the API to the account's root", async () => {
    const management = await seedManagementKey();
    const created = await admin(management, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: `openai-${crypto.randomUUID().slice(0, 6)}`, secret: SECRET });
    expect(created.status).toBe(201);
    const id = created.body.provider.id as string;
    const row = await env.DB.prepare("SELECT secret_blob FROM provider_connection WHERE id = ?").bind(id).first<{ secret_blob: string }>();
    expect(isSplit(await open(TEST_VAULT_ENV, "providerKey", [ACCOUNT_ID, id, "openai", "", "", ""], row!.secret_blob))).toBe(true);
    // And an app key of the account opens it.
    const { appId, key } = await app(created.body.provider.slug as string);
    fetchSpy.mockResolvedValue(Response.json({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    expect((await call(`/v2/apps/${appId}/proxy/${created.body.provider.slug}/v1/chat/completions`, chat(`Bearer ${key.key}`))).status).toBe(200);
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("deletes a key's keyslot when the key is revoked, and every keyslot of a deleted app", async () => {
    const management = await seedManagementKey();
    const { slug } = await seedSplitConnection();
    const { appId, key } = await app(slug);
    const other = await seedAppKey(appId);
    const slots = async () =>
      (await env.DB.prepare("SELECT credential_id FROM key_slot WHERE credential_id IN (?, ?) ORDER BY credential_id").bind(key.id, other.id).all()).results.length;
    expect(await slots()).toBe(2);
    expect((await admin(management, "POST", `/v2/admin/apps/${appId}/keys/${key.id}/revoke`)).status).toBe(200);
    expect(await slots()).toBe(1);
    expect((await admin(management, "DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).status).toBe(200);
    expect(await slots()).toBe(0);
  });

  it("needs the key again to move a stored key back to the provider's own address", async () => {
    const management = await seedManagementKey();
    const created = await admin(management, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "OpenAI",
      slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
      secret: SECRET,
      baseUrl: "https://llm.example.com/v1",
    });
    expect(created.status).toBe(201);
    const { id, revision } = created.body.provider;
    expect(await admin(management, "PUT", `/v2/admin/providers/${id}`, { revision, baseUrl: null })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await admin(management, "PUT", `/v2/admin/providers/${id}`, { revision, baseUrl: null, secret: SECRET })).toMatchObject({ status: 200 });
  });

  it("keeps a copy of a fal job's key on its check row, which opens with no credential", async () => {
    const { slug, id } = await seedSplitConnection("fal");
    const { appId, key } = await app(slug, ["fal.queue"]);
    fetchSpy.mockResolvedValue(
      Response.json({
        request_id: "req-1",
        status: "IN_QUEUE",
        status_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
        response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1",
      }),
    );
    const response = await call(`/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(response.status).toBe(200);
    const { results } = await ledger().prepare("SELECT detail_json FROM open_work WHERE app_id = ? AND kind = 'job_check'").bind(appId).all<{ detail_json: string }>();
    expect(results).toHaveLength(1);
    const copy = (JSON.parse(results[0]!.detail_json) as { keyCopies: { providerKey: { blob: string; identity: string[] } } }).keyCopies.providerKey;
    expect(copy.identity.slice(0, 6)).toEqual([ACCOUNT_ID, id, "fal", "", "", ""]);
    const expiresAt = Number(copy.identity[6]);
    expect(expiresAt).toBeGreaterThan(Date.now() + 60 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + MAX_STORED_COPY_MS);
    forgetOpenedKeys();
    await expect(keyForRequest(TEST_VAULT_ENV, "storedProviderKey", copy.identity, copy.blob)).resolves.toBe(SECRET);

    // The sweep checks the job with that copy: no app request brings a credential then.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/status")
        ? Response.json({ status: "COMPLETED" })
        : Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "1" } }),
    );
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    expect(fetchSpy).toHaveBeenCalled();
    for (const [, init] of fetchSpy.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Key ${SECRET}`);
    const { results: kinds } = await ledger().prepare("SELECT kind FROM charge WHERE app_id = ? ORDER BY kind").bind(appId).all<{ kind: string }>();
    expect(kinds.map((row) => row.kind)).toEqual(["correction", "estimate"]);
  });

  it("ends a job's check, keeping the estimate, when its key copy could not be made", async () => {
    const { slug } = await seedSplitConnection("fal");
    const { appId, key } = await app(slug, ["fal.queue"]);
    fetchSpy.mockResolvedValue(Response.json({ request_id: "req-2", status: "IN_QUEUE" }));
    const response = await call(`/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a dog" }),
    });
    expect(response.status).toBe(200);
    const row = await ledger().prepare("SELECT id, detail_json FROM open_work WHERE app_id = ? AND kind = 'job_check'").bind(appId).first<{ id: string; detail_json: string }>();
    const detail = { ...(JSON.parse(row!.detail_json) as Record<string, unknown>), keyCopies: "missing" };
    await ledger().prepare("UPDATE open_work SET detail_json = ? WHERE id = ?").bind(JSON.stringify(detail), row!.id).run();
    fetchSpy.mockReset();
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ledger().prepare("SELECT id FROM open_work WHERE id = ?").bind(row!.id).first()).toBeNull();
    const { results: kinds } = await ledger().prepare("SELECT kind FROM charge WHERE app_id = ?").bind(appId).all<{ kind: string }>();
    expect(kinds.map((one) => one.kind)).toEqual(["estimate"]);
  });
});

describe("key copies go with their check (Sol round 1)", () => {
  const COPY = { providerKey: { blob: "local1.1.x.y", identity: [ACCOUNT_ID, "conn", "fal", "", "", ""] } };

  async function row(id: string, keyCopies: unknown, dueAt: number): Promise<void> {
    await ledger()
      .prepare(
        `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
         VALUES (?, 'job_check', ?, 'app_copies', 'job', ?, NULL, ?, ?, 0, 0)`,
      )
      .bind(id, ACCOUNT_ID, id, JSON.stringify({ jobId: `signed_${id}`, maxTries: 1, keyCopies }), dueAt)
      .run();
  }

  async function detail(id: string): Promise<Record<string, unknown> | null> {
    const found = await ledger().prepare("SELECT detail_json FROM open_work WHERE id = ?").bind(id).first<{ detail_json: string }>();
    return found === null ? null : (JSON.parse(found.detail_json) as Record<string, unknown>);
  }

  beforeAll(() => seedAccount());

  it("removes a check's copies when it gives up, keeping the rest for the console", async () => {
    const id = `job:give_up_${crypto.randomUUID().slice(0, 6)}`;
    const until = String(Date.now() + 60 * 60_000);
    await row(id, { providerKey: { ...COPY.providerKey, identity: [...COPY.providerKey.identity, until] } }, 0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handlers = { ...OPEN_WORK_HANDLERS, job_check: async () => ({ done: false as const, reason: "not done" }) };
    await runSweep(env, ledger(), { now: Date.now(), handlers });
    const gaveUp = await ledger().prepare("SELECT gave_up_at FROM open_work WHERE id = ?").bind(id).first<{ gave_up_at: number | null }>();
    expect(gaveUp?.gave_up_at).not.toBeNull();
    expect(await detail(id)).toEqual({ jobId: `signed_${id}`, maxTries: 1, keyCopies: "removed" });
    vi.restoreAllMocks();
  });

  it("removes copies past their expiry on every sweep, even on a row not yet due, and leaves the rest", async () => {
    const expired = `job:expired_${crypto.randomUUID().slice(0, 6)}`;
    const current = `job:current_${crypto.randomUUID().slice(0, 6)}`;
    const now = Date.now();
    const later = now + 60 * 60_000;
    await row(expired, { providerKey: { ...COPY.providerKey, identity: [...COPY.providerKey.identity, String(now - 1)] } }, later);
    await row(current, { providerKey: { ...COPY.providerKey, identity: [...COPY.providerKey.identity, String(later)] } }, later);
    await runSweep(env, ledger(), { now });
    expect((await detail(expired))?.keyCopies).toBe("removed");
    expect((await detail(expired))?.jobId).toBe(`signed_${expired}`);
    expect((await detail(current))?.keyCopies).toMatchObject({ providerKey: { blob: COPY.providerKey.blob } });
  });
});
