import { secretVault } from "./index";
import {
  SecretVaultConfigurationError,
  VAULT_SERVICE,
  type SecretVaultContext,
} from "./types";

/**
 * Every secret this gateway seals, and the encryption context each one is
 * bound to.
 *
 * This table is the only place a context is written. A context is AES-GCM
 * additional data: a blob sealed under one can only ever be opened under a
 * byte-identical one, so the sealing side and the opening side must agree
 * forever. Spelling a context out at each call site made that agreement a
 * matter of memory — and `resource-create-receipt` was already written twice by
 * hand, once to seal and once to open, with nothing to keep the two in step.
 *
 * Adding a secret means adding a line here, where the whole set is visible at
 * once, rather than burying a new context in a route.
 *
 * The values are what distinguish one blob from another, and they are what does
 * the security work: an organization's provider key is bound to that
 * organization and that provider, so a blob lifted into another row no longer
 * opens. `service` is not one of them — it is constant, so it separates
 * nothing — and it is added by {@link secretContext} rather than named here,
 * for the reason given on {@link VAULT_SERVICE}.
 */
const SECRET_CONTEXTS = {
  providerKey: (
    organizationId: string,
    providerId: string,
    providerType: string,
    baseUrl: string,
  ) => ({
    organizationId,
    providerId,
    providerType,
    baseUrl,
  }),
  providerGatewayToken: (organizationId: string, providerGatewayId: string) => ({
    organizationId,
    providerGatewayId,
  }),
  cliCredential: (operationId: string, pollProofHash: string) => ({
    purpose: "cli-credential-exchange",
    operationId,
    pollProofHash,
  }),
  resourceReceipt: (receiptId: string, proofHash: string) => ({
    purpose: "resource-create-receipt",
    receiptId,
    proofHash,
  }),
} as const satisfies Record<string, (...args: string[]) => Record<string, string>>;

export type SecretKind = keyof typeof SECRET_CONTEXTS;

/** The ids one kind of secret is bound to, in the order the table declares them. */
export type SecretIdentity<K extends SecretKind> = Parameters<(typeof SECRET_CONTEXTS)[K]>;

/**
 * What cf-kms accepts in an encryption context, enforced here in every vault
 * mode.
 *
 * `local` mode binds whatever object it is handed, so a context cf-kms would
 * refuse still round-trips in development and in the test suite, and first
 * fails in a deployment that runs `kms`. Applying the stricter of the two rules
 * everywhere is what makes `pnpm run test` able to speak for both.
 */
const MAX_ENTRIES = 8;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/**
 * Rejects a context no cf-kms deployment would accept.
 *
 * `SecretVaultConfigurationError` rather than a `GatewayError`, because this is
 * a fault in the gateway itself and not a refusal the caller can act on — and
 * because `isVaultTransportFailure` reads that type as a hard fault, so a
 * malformed context can never be papered over with a cached plaintext the way a
 * vault outage may be.
 */
function assertUsable(kind: string, context: Record<string, string>): SecretVaultContext {
  const entries = Object.entries(context);
  if (entries.length > MAX_ENTRIES) {
    throw new SecretVaultConfigurationError(
      `${kind} context has ${entries.length} entries; at most ${MAX_ENTRIES} are allowed`,
    );
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
      throw new SecretVaultConfigurationError(`${kind} context key ${JSON.stringify(key)} is not usable`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new SecretVaultConfigurationError(
        `${kind} context value for ${key} is ${value.length} characters; at most ${MAX_VALUE_LENGTH} are allowed`,
      );
    }
  }
  return context as SecretVaultContext;
}

/**
 * The context one secret is sealed and opened under.
 *
 * Exported for the tests that walk the table and for the fixtures that seal a
 * row directly; everything else goes through {@link sealSecret} and
 * {@link openSecret}, which cannot hand the two sides different contexts.
 */
export function secretContext<K extends SecretKind>(
  kind: K,
  identity: SecretIdentity<K>,
): SecretVaultContext {
  const build = SECRET_CONTEXTS[kind] as (...args: string[]) => Record<string, string>;
  // `service` last: the invariant wins over anything the table names, so no
  // entry can quietly opt out of the caller identity cf-kms pins.
  return assertUsable(kind, { ...build(...identity), service: VAULT_SERVICE });
}

export function sealSecret<K extends SecretKind>(
  env: Env,
  kind: K,
  identity: SecretIdentity<K>,
  plaintext: string,
): Promise<string> {
  return secretVault(env).encryptSecret(plaintext, secretContext(kind, identity));
}

export function openSecret<K extends SecretKind>(
  env: Env,
  kind: K,
  identity: SecretIdentity<K>,
  blob: string,
): Promise<string> {
  return secretVault(env).decryptSecret(blob, secretContext(kind, identity));
}

/** The kinds the table declares, for tests that must cover all of them. */
export const SECRET_KINDS = Object.keys(SECRET_CONTEXTS) as SecretKind[];

/** How many ids a kind binds to, so a test can build one without naming them. */
export function secretIdentityLength(kind: SecretKind): number {
  return SECRET_CONTEXTS[kind].length;
}
