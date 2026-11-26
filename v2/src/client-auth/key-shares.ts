/**
 * iOS shares (plan step 8j, phase 3): the secret an App Attest app of an
 * account with split keys on ships in its configuration and sends at
 * `/auth/token`. It opens the share's keyslot, and so the account's provider
 * keys, for that install's requests. The gateway checks it at the exchange,
 * seals it into the gateway token, and on each request hands it to the vault
 * as a `KeyShare`.
 *
 * A share is `shr_<20 letters or digits>.<secret>`: its id comes first, so
 * its keyslot is found without a hash. The whole string is the credential the
 * vault derives the key pair from. Only the share's keyslot and public key
 * are stored, never the share.
 */
import { and, eq } from "drizzle-orm";
import { GatewayError } from "../core/errors.ts";
import { readOrKnown } from "../core/stale-read.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import { database, type Database } from "../db/index.ts";
import { accountKeyRoot, appKeyShare, keySlot } from "../db/schema.ts";
import { vault } from "../vault/client.ts";
import type { SealedKeySlot } from "../vault/key-share.ts";

const SHARE = /^(shr_[0-9a-z]{20})\.[A-Za-z0-9_-]{32,128}$/u;

/** A share's id, or null when the text is not shaped like a share. */
export function shareId(share: string): string | null {
  return SHARE.exec(share)?.[1] ?? null;
}

interface ShareRecord {
  appId: string;
  publicKey: string;
  slot: SealedKeySlot;
}

/** An active share with its keyslot: one query. */
async function lookupActiveShare(db: Database, id: string): Promise<ShareRecord | null> {
  const [row] = await db
    .select({ appId: appKeyShare.appId, account: keySlot.accountId, publicKey: keySlot.publicKey, blob: keySlot.sealedRoot })
    .from(appKeyShare)
    .innerJoin(keySlot, and(eq(keySlot.credentialKind, "ios_share"), eq(keySlot.credentialId, appKeyShare.id)))
    .where(and(eq(appKeyShare.id, id), eq(appKeyShare.status, "active")))
    .limit(1);
  if (row === undefined) return null;
  return { appId: row.appId, publicKey: row.publicKey, slot: { blob: row.blob, identity: [row.account, id, "ios_share"] } };
}

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;

/**
 * Shares by id for requests, as app keys are cached by id (`./api-keys.ts`):
 * the TTL is how long a revoked share keeps opening keys for tokens already
 * issued. Bounded; ids come from tokens this gateway signed.
 */
export const shareCache = ttlCache<string, ShareRecord | null>({ name: "key-share", ttlMs: HIT_TTL_MS, maxEntries: 10_000 });

/** The keyslot of an active share, for a request whose token carries the share. */
export async function lookupActiveShareById(env: Env, id: string): Promise<ShareRecord | null> {
  const now = Date.now();
  const cached = shareCache.peek(id);
  if (cached && cached.expiresAt > now) return cached.value;
  const known = cached?.value ? { value: cached.value, storedAt: cached.storedAt } : undefined;
  return readOrKnown<ShareRecord | null>("key_share", known, async () => {
    const startedAt = Date.now();
    const value = await lookupActiveShare(database(env.DB), id);
    shareCache.set(id, value, { storedAt: startedAt, ttlMs: value ? HIT_TTL_MS : MISS_TTL_MS });
    return value;
  });
}

/** Whether the account has split keys on, so its App Attest apps must send a share. */
export async function splitKeysOn(env: Env, accountId: string): Promise<boolean> {
  const row = await database(env.DB).query.accountKeyRoot.findFirst({
    columns: { mode: true },
    where: eq(accountKeyRoot.accountId, accountId),
  });
  return row?.mode === "on";
}

function shareRefused(): GatewayError {
  return new GatewayError(401, "auth_required", "The app's key share was not accepted");
}

/**
 * Checks a share an install sent at `/auth/token`, read straight from D1 so a
 * revoked share is refused at once: it must be this app's, active, and the
 * one its keyslot was made for (the vault derives its public key again).
 * Returns the share's id.
 */
export async function checkShare(env: Env, appId: string, accountId: string, share: string): Promise<string> {
  const id = shareId(share);
  if (id === null) throw shareRefused();
  const record = await lookupActiveShare(database(env.DB), id);
  if (record === null || record.appId !== appId || record.slot.identity[0] !== accountId) throw shareRefused();
  if (!(await vault(env).credentialMatches(share, record.publicKey))) throw shareRefused();
  return id;
}
