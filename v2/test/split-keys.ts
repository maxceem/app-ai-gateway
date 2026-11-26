/**
 * Split keys in the tests (plan step 8j). Phase 2 (passkeys in the console)
 * does not exist yet, so a test makes a split-key account here, the way
 * turning split keys on will: a root key, its public key in D1, a keyslot for
 * each app key, and provider keys sealed to the root.
 *
 * The files that touch provider keys run twice: once as they are, and once
 * in the `v2-split-keys` project (`vitest.config.ts`), where the test
 * account has split keys on, every seeded app key has a keyslot, and every
 * App Attest app gets an iOS share that its installs send at `/auth/token`
 * and their tokens carry (phase 3).
 */
import { env } from "cloudflare:workers";
import { additionalData, seal, sealAs, secretContext } from "../vault/src/seal.js";
import { credentialPublicKey, newRoot, sealRootToCredential } from "../vault/src/split.js";
import type { SecretIdentity } from "../src/vault/secrets.ts";
import { KeyShare } from "../src/vault/key-share.ts";
import type { KeySlotCredentialKind } from "../src/db/schema.ts";
import { TEST_VAULT_ENV } from "./local-vault.ts";

/** Whether this run is the split-key one: the test account has split keys on. */
export const splitKeysOn = (env as unknown as { TEST_SPLIT_KEYS?: string }).TEST_SPLIT_KEYS === "1";

const roots = new Map<string, { readonly privateKey: Uint8Array; readonly publicKey: string }>();

/** Turns split keys on for an account: a new root, and its public key in D1. Returns the public key. */
export async function enableSplitKeys(accountId: string): Promise<string> {
  const root = await newRoot();
  roots.set(accountId, root);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO account_key_root(account_id, public_key, mode, migration_json, created_at, updated_at) VALUES (?, ?, 'on', NULL, ?, ?)",
  )
    .bind(accountId, root.publicKey, now, now)
    .run();
  return root.publicKey;
}

/** Whether a test made this account a split-key one. */
export function hasSplitKeys(accountId: string): boolean {
  return roots.has(accountId);
}

/** A credential's keyslot, sealed: the root sealed to the credential's public key, inside the KEK. */
async function makeKeySlot(
  accountId: string,
  credentialId: string,
  secret: string,
  kind: KeySlotCredentialKind = "api_key",
): Promise<{ readonly blob: string; readonly publicKey: string }> {
  const root = roots.get(accountId);
  if (root === undefined) throw new Error(`split keys are not on for ${accountId}`);
  const identity = [accountId, credentialId, kind];
  const publicKey = await credentialPublicKey(secret);
  const inner = await sealRootToCredential(root.privateKey, publicKey, additionalData(secretContext("keySlot", identity)));
  return { blob: await sealAs(TEST_VAULT_ENV, "keySlot", identity, inner), publicKey };
}

/**
 * A keyslot for an app key of a split-key account, stored, as the browser
 * will make it (phase 2).
 */
export async function addKeySlot(accountId: string, credentialId: string, secret: string): Promise<void> {
  const { blob, publicKey } = await makeKeySlot(accountId, credentialId, secret);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO key_slot(id, account_id, credential_kind, credential_id, public_key, sealed_root, created_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?)",
  )
    .bind(`slot_${credentialId}`, accountId, credentialId, publicKey, blob, Date.now())
    .run();
}

/**
 * An iOS share for an App Attest app of a split-key account, stored as the
 * browser will make one (phase 2): its row, and its keyslot. Returns the
 * share, which only the app holds.
 */
export async function addIosShare(accountId: string, appId: string, name = "test share"): Promise<{ readonly id: string; readonly share: string }> {
  const id = `shr_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => "0123456789abcdefghijklmnopqrstuvwxyz"[byte % 36]).join("")}`;
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const share = `${id}.${secret}`;
  const { blob, publicKey } = await makeKeySlot(accountId, id, share, "ios_share");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_key_share(id, app_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)").bind(id, appId, name, now),
    env.DB.prepare(
      "INSERT INTO key_slot(id, account_id, credential_kind, credential_id, public_key, sealed_root, created_at) VALUES (?, ?, 'ios_share', ?, ?, ?, ?)",
    ).bind(`slot_${id}`, accountId, id, publicKey, blob, now),
  ]);
  return { id, share };
}

const appShares = new Map<string, Promise<string | null>>();

/**
 * The iOS share an App Attest app's installs send in the split-key run: one
 * per app, made on first use. Null when the app's account has split keys off.
 */
export function shareForApp(appId: string): Promise<string | null> {
  if (!appShares.has(appId)) {
    appShares.set(
      appId,
      (async () => {
        const owner = await env.DB.prepare("SELECT account_id FROM app WHERE id = ?").bind(appId).first<{ account_id: string }>();
        if (owner === null || !roots.has(owner.account_id)) return null;
        return (await addIosShare(owner.account_id, appId)).share;
      })(),
    );
  }
  return appShares.get(appId)!;
}

/**
 * A provider key or Cloudflare token sealed the way saving it seals it: to
 * the account's root as well when split keys are on there.
 */
export function sealForTest<K extends "providerKey" | "cloudflareGatewayToken">(
  kind: K,
  identity: SecretIdentity<K>,
  plaintext: string,
): Promise<string> {
  return seal(TEST_VAULT_ENV, kind, [...identity], plaintext, roots.get(identity[0])?.publicKey);
}

const shares = new Map<string, Promise<KeyShare>>();

/**
 * A share that opens the account's keys, for tests that build a call by hand
 * rather than send a request: null when split keys are off there.
 */
export function testShare(accountId: string): Promise<KeyShare | null> {
  if (!roots.has(accountId)) return Promise.resolve(null);
  if (!shares.has(accountId)) {
    const secret = "agw_test_hand_built_call";
    shares.set(
      accountId,
      makeKeySlot(accountId, "key_hand_built", secret).then(({ blob }) => new KeyShare(secret, { blob, identity: [accountId, "key_hand_built", "api_key"] })),
    );
  }
  return shares.get(accountId)!;
}
