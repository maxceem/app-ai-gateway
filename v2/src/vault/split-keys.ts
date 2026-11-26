/**
 * Split keys on the gateway's side (plan step 8j): which root a new key of an
 * account is sealed to. The crypto is the vault's (`v2/vault/src/split.js`);
 * this Worker only reads the account's public key and passes it on.
 */
import { eq } from "drizzle-orm";
import { GatewayError } from "../core/errors.ts";
import { database } from "../db/index.ts";
import { accountKeyRoot } from "../db/schema.ts";

/**
 * The root public key new provider keys of the account are sealed to, or
 * undefined unless split keys are on. Read from D1 each time: only saving a
 * key asks, never a request. (`migrating` comes with phase 4, which decides
 * how a key is sealed during the move.)
 */
export async function sealingRoot(env: Env, accountId: string): Promise<string | undefined> {
  const row = await database(env.DB).query.accountKeyRoot.findFirst({
    columns: { publicKey: true, mode: true },
    where: eq(accountKeyRoot.accountId, accountId),
  });
  return row?.mode === "on" ? row.publicKey : undefined;
}

/**
 * Moving a stored key to another address needs the key again when split
 * keys are on: the key is sealed to its address inside the root's seal too,
 * and this Worker and the vault cannot open the root without the customer
 * (a passkey, once the console has them).
 */
export function keyNeededToMove(): GatewayError {
  return new GatewayError(
    400,
    "invalid_request",
    "secret: with split keys on, moving a stored key to another address needs the key in the same request",
  );
}
