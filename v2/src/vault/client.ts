/**
 * The one way the gateway reaches the vault Worker (`v2/vault/`), plan step
 * 8i: sealing a new credential, sealing one again for a new address, and
 * sending a call that carries a sealed credential. The gateway never sees a
 * key it sends this way: the vault opens it, adds it, and streams the answer
 * back without it.
 *
 * In a deployment this always goes through the `VAULT` service binding. The
 * tests can swap in the vault's own modules, run in this Worker
 * (`setVaultForTests`), so their fetch stand-ins see what the vault sends; a
 * test runs both. It is never a setting a deployment can choose.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { SecretIdentity, SecretKind } from "./secrets.ts";

/** The request header sealed credentials travel in, as the vault reads it (`v2/vault/src/call.js`). */
export const VAULT_CALL_HEADER = "x-agw-vault";
/** Set on an answer the vault gives itself, never on a provider's. Its value is a code. */
export const VAULT_ERROR_HEADER = "x-agw-vault-error";

/** A provider key, sealed, with the header and format it is sent in. */
export interface SealedProviderKey {
  readonly blob: string;
  readonly identity: SecretIdentity<"providerKey">;
  readonly header: string;
  readonly format: string;
}

/** A Cloudflare AI Gateway token, sealed. */
export interface SealedCloudflareToken {
  readonly blob: string;
  readonly identity: SecretIdentity<"cloudflareGatewayToken">;
}

/** What one call carries, sealed. */
export interface SealedCallCredentials {
  readonly providerKey?: SealedProviderKey;
  readonly cloudflareToken?: SealedCloudflareToken;
}

export interface VaultCall {
  readonly url: string;
  readonly method: string;
  /** Every header but the credentials, which the vault adds. */
  readonly headers: Headers;
  readonly body: BodyInit | null;
  readonly signal?: AbortSignal;
  readonly credentials: SealedCallCredentials;
}

export interface VaultClient {
  seal<K extends SecretKind>(kind: K, identity: SecretIdentity<K>, plaintext: string): Promise<string>;
  reseal<K extends SecretKind>(kind: K, from: SecretIdentity<K>, to: SecretIdentity<K>, blob: string): Promise<string>;
  /** The provider's answer. Throws a 502 `provider_unavailable` when the vault itself refuses. */
  call(input: VaultCall): Promise<Response>;
  /** For each text, whether it holds one of the credentials: only yes or no comes back. */
  holds(credentials: SealedCallCredentials, texts: readonly string[]): Promise<boolean[]>;
}

/** The vault Worker's entrypoint as the binding exposes it. */
interface VaultBinding {
  fetch(request: Request): Promise<Response>;
  seal(kind: string, identity: string[], plaintext: string): Promise<string>;
  reseal(kind: string, from: string[], to: string[], blob: string): Promise<string>;
  holds(credentials: SealedCallCredentials, texts: string[]): Promise<boolean[]>;
}

let testVault: ((env: Env) => VaultClient) | null = null;

/** For the tests only: run the vault in this Worker, or (null) go back to the binding. */
export function setVaultForTests(factory: ((env: Env) => VaultClient) | null): void {
  testVault = factory;
}

/**
 * A provider answer, or the vault's own refusal as a gateway error: 502
 * `provider_unavailable`, the same as a key that cannot be opened always was.
 */
export function vaultAnswer(response: Response): Response {
  const code = response.headers.get(VAULT_ERROR_HEADER);
  if (code === null) return response;
  log("error", "provider_secret_unavailable", { vault: code });
  throw new GatewayError(502, "provider_unavailable", "The provider credential could not be used");
}

function bindingClient(binding: VaultBinding): VaultClient {
  return {
    seal: (kind, identity, plaintext) => binding.seal(kind, [...identity], plaintext),
    reseal: (kind, from, to, blob) => binding.reseal(kind, [...from], [...to], blob),
    holds: (credentials, texts) => binding.holds(credentials, [...texts]),
    call: async (input) => {
      const headers = new Headers(input.headers);
      headers.set(VAULT_CALL_HEADER, JSON.stringify(input.credentials));
      const request = new Request(input.url, {
        method: input.method,
        headers,
        body: input.body,
        redirect: "manual",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return vaultAnswer(await binding.fetch(request));
    },
  };
}

/** The vault, through the `VAULT` binding. A deployment without one cannot send a provider key. */
export function vault(env: Env): VaultClient {
  if (testVault !== null) return testVault(env);
  const binding = (env as unknown as { VAULT?: VaultBinding }).VAULT;
  if (binding === undefined) {
    log("error", "vault_unbound", {});
    throw new GatewayError(503, "service_unavailable", "The vault is not reachable");
  }
  return bindingClient(binding);
}
