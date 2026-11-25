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
/** The caller's deadline over the binding, in epoch ms, as the vault reads it (`v2/vault/src/call.js`). */
export const VAULT_DEADLINE_HEADER = "x-agw-vault-deadline";

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
  /**
   * When this Worker gives up on the call, in epoch ms: the same deadline its
   * signal aborts on. The vault stops waiting on cf-kms before it, so a stall
   * comes back as the vault's refusal (nothing sent, nothing charged), never
   * as this Worker giving up on a call it cannot tell apart.
   */
  readonly deadline?: number;
  readonly credentials: SealedCallCredentials;
}

export interface VaultClient {
  seal<K extends SecretKind>(kind: K, identity: SecretIdentity<K>, plaintext: string): Promise<string>;
  reseal<K extends SecretKind>(kind: K, from: SecretIdentity<K>, to: SecretIdentity<K>, blob: string): Promise<string>;
  /** The provider's answer. Throws a 502 `provider_unavailable` when the vault itself refuses. */
  call(input: VaultCall): Promise<Response>;
  /** For each text, whether it holds one of the credentials: only yes or no comes back. */
  holds(credentials: SealedCallCredentials, texts: readonly string[]): Promise<boolean[]>;
  /** Whether the vault's settings let it seal and open keys. */
  status(): Promise<"ok" | "misconfigured">;
}

/** The vault Worker's entrypoint as the binding exposes it. */
interface VaultBinding {
  fetch(request: Request): Promise<Response>;
  seal(kind: string, identity: string[], plaintext: string): Promise<string>;
  reseal(kind: string, from: string[], to: string[], blob: string): Promise<string>;
  holds(credentials: SealedCallCredentials, texts: string[]): Promise<boolean[]>;
  status(): Promise<"ok" | "misconfigured">;
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
/** The codes the vault refuses with (`v2/vault/src/call.js`): only these are logged by name. */
const VAULT_REFUSALS: ReadonlySet<string> = new Set(["bad_request", "destination_refused", "credential_unavailable", "misconfigured"]);

export function vaultAnswer(response: Response): Response {
  const code = response.headers.get(VAULT_ERROR_HEADER);
  if (code === null) return response;
  log("error", "provider_secret_unavailable", { vault: VAULT_REFUSALS.has(code) ? code : "unknown" });
  throw new GatewayError(502, "provider_unavailable", "The provider credential could not be used");
}

function bindingClient(binding: VaultBinding): VaultClient {
  return {
    // Awaited inside, so callers get a plain promise rather than the binding's own thenable.
    seal: async (kind, identity, plaintext) => await binding.seal(kind, [...identity], plaintext),
    reseal: async (kind, from, to, blob) => await binding.reseal(kind, [...from], [...to], blob),
    holds: async (credentials, texts) => await binding.holds(credentials, [...texts]),
    status: async () => await binding.status(),
    call: async (input) => {
      const headers = new Headers(input.headers);
      headers.set(VAULT_CALL_HEADER, JSON.stringify(input.credentials));
      if (input.deadline !== undefined) headers.set(VAULT_DEADLINE_HEADER, String(input.deadline));
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

const VAULT_STATUS_DEADLINE_MS = 1_000;

/**
 * The vault's own report for the health check: `misconfigured` when its
 * settings are missing or wrong, or when it cannot be reached in time.
 */
export async function vaultStatus(env: Env): Promise<"ok" | "misconfigured"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<"misconfigured">((resolve) => {
      timer = setTimeout(() => resolve("misconfigured"), VAULT_STATUS_DEADLINE_MS);
    });
    return await Promise.race([vault(env).status(), late]);
  } catch {
    return "misconfigured";
  } finally {
    clearTimeout(timer);
  }
}
