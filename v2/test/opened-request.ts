/**
 * For the tests only: a request to a provider as the vault sends it, with the
 * credentials in plain text, so a test can check where a key goes and in
 * which header without a fetch stand-in. The gateway itself never builds one:
 * it sends `sealedUpstreamRequest` to the vault, which adds the key the same
 * way (`v2/vault/src/call.js`).
 */
import { GatewayError } from "../src/core/errors.ts";
import { sealedCredentials, type ConnectionRecord } from "../src/providers/connections.ts";
import type { ProviderDescription } from "../src/providers/operation.ts";
import { sealedUpstreamRequest, type UpstreamRequestInput } from "../src/providers/route.ts";
import { openSecret, type SecretIdentity } from "../src/vault/secrets.ts";

export interface OpenedCredentials {
  readonly providerKey: string | null;
  readonly cloudflareToken: string | null;
}

export interface OpenedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly keyHeader: string;
}

/** The URL and headers a call would reach the provider with, the credentials added as the vault adds them. */
export function upstreamRequest(
  connection: ConnectionRecord,
  description: ProviderDescription,
  input: UpstreamRequestInput & { readonly credentials: OpenedCredentials },
): OpenedRequest {
  const placeholder = { blob: "", identity: ["", "", "", "", "", ""] as [string, string, string, string, string, string] };
  const target = sealedUpstreamRequest(connection, description, {
    ...input,
    credentials: {
      providerKey: input.credentials.providerKey === null ? null : placeholder,
      cloudflareToken: input.credentials.cloudflareToken === null ? null : { blob: "", identity: ["", "", "", ""] as [string, string, string, string] },
    },
  });
  const headers: Record<string, string> = { ...target.headers };
  const key = target.credentials.providerKey;
  if (key !== undefined && input.credentials.providerKey !== null) headers[key.header] = key.format.replace("{key}", () => input.credentials.providerKey!);
  if (target.credentials.cloudflareToken !== undefined && input.credentials.cloudflareToken !== null) {
    headers["cf-aig-authorization"] = `Bearer ${input.credentials.cloudflareToken}`;
  }
  return { url: target.url, headers, keyHeader: target.keyHeader };
}

/** A connection's credentials, opened with the vault settings given, as the vault opens them. A failure is the gateway's 502. */
export async function connectionCredentials(vaultEnv: unknown, connection: ConnectionRecord): Promise<OpenedCredentials> {
  const sealed = sealedCredentials(connection);
  try {
    return {
      providerKey: sealed.providerKey === null ? null : await openSecret(vaultEnv as Env, "providerKey", sealed.providerKey.identity as SecretIdentity<"providerKey">, sealed.providerKey.blob),
      cloudflareToken:
        sealed.cloudflareToken === null
          ? null
          : await openSecret(vaultEnv as Env, "cloudflareGatewayToken", sealed.cloudflareToken.identity as SecretIdentity<"cloudflareGatewayToken">, sealed.cloudflareToken.blob),
    };
  } catch {
    throw new GatewayError(502, "provider_unavailable", "The provider credential could not be opened");
  }
}
