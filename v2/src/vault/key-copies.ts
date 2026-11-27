/**
 * Key copies for work with no app request (plan step 8j, "Keys needed with no app request"): a fal job's
 * checks, and a stream's provider lookup after it ends. For an account with split keys on, the app's
 * credential is present only when the app asks, so the vault copies the connection's credentials then,
 * sealed with the KEK alone until the work's time is up. They go on the work's open-work row, in its
 * detail (`KEY_COPIES_FIELD`), and are removed with it, or once they expire (`../ledger/sweep.ts`).
 */
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { KEY_COPIES_FIELD } from "../ledger/write.ts";
import type { SealedCredentials } from "../providers/connections.ts";
import { vault, type CopyRequest, type StoredCopies } from "./client.ts";

/** How long making the copies may take: it runs after the answer is sent, and never fails the request. */
export const KEY_COPY_DEADLINE_MS = 5_000;

/**
 * Copies of `credentials`, sealed until `expiresAt`: undefined for an account with split keys off, which
 * needs none (no app credential came), and "missing" when they couldn't be made, logged as `failure`
 * with `facts`: the work then ends, its estimate kept.
 */
export async function storeKeyCopies(
  env: Env,
  credentials: SealedCredentials,
  expiresAt: number,
  failure: { readonly message: string; readonly facts: Readonly<Record<string, unknown>> },
): Promise<StoredCopies | "missing" | undefined> {
  const credential = credentials.credential;
  if (credential === undefined) return undefined;
  try {
    return await withDeadline(
      vault(env).storeCopy(
        {
          ...(credentials.providerKey === null ? {} : { providerKey: credentials.providerKey as CopyRequest["providerKey"] & object }),
          ...(credentials.cloudflareToken === null ? {} : { cloudflareToken: credentials.cloudflareToken as CopyRequest["cloudflareToken"] & object }),
          credential,
        },
        expiresAt,
      ),
      KEY_COPY_DEADLINE_MS,
      "copying the key for work with no app request",
    );
  } catch (error) {
    log("warn", failure.message, { ...failure.facts, error: errorFacts(error) });
    return "missing";
  }
}

/**
 * A row's key copies: the copies; "missing" when they could not be made or were removed (`removed`, past
 * their expiry, `../ledger/sweep.ts`); or null for an account with split keys off.
 */
export function keyCopiesOf(detail: Readonly<Record<string, unknown>> | null): StoredCopies | "missing" | null {
  const value = detail?.[KEY_COPIES_FIELD];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "missing";
  return value as StoredCopies;
}
