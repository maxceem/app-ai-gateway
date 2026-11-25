// @ts-check
/**
 * One call to a provider with a sealed credential: the only way the gateway
 * sends a request that carries a provider key.
 *
 * The gateway sends everything but the key: where to, the method, the
 * headers, the body, and the sealed credentials with the header the key goes
 * in. This Worker checks the address against the one the key is sealed for,
 * opens the key, adds it, and streams the answer back without the key header.
 * It never follows a redirect, never logs a key and never returns one.
 */
import { PROVIDER_HOSTS } from "./hosts.js";
import { VaultBlobError, VaultConfigurationError, open } from "./seal.js";

/** @typedef {import("./seal.js").VaultEnv} VaultEnv */

/**
 * A provider key, sealed, with where it goes in the request.
 * @typedef {{ readonly blob: string, readonly identity: readonly string[], readonly header: string, readonly format: string }} SealedKey
 */
/**
 * A Cloudflare AI Gateway token, sealed.
 * @typedef {{ readonly blob: string, readonly identity: readonly string[] }} SealedToken
 */
/**
 * What a call carries, sealed. At least one is set.
 * @typedef {{ readonly providerKey?: SealedKey, readonly cloudflareToken?: SealedToken }} SealedCredentials
 */
/**
 * @typedef {{
 *   readonly url: string,
 *   readonly method: string,
 *   readonly headers: Headers,
 *   readonly body: BodyInit | null,
 *   readonly signal?: AbortSignal,
 *   readonly credentials: SealedCredentials,
 * }} VaultCall
 */

/** The request header the sealed credentials travel in over the service binding. */
export const CALL_HEADER = "x-agw-vault";
/** Set on an answer the vault itself gives, never on a provider's. Its value is a code. */
export const VAULT_ERROR_HEADER = "x-agw-vault-error";

/** Cloudflare AI Gateway's own origin. Only Cloudflare's: the vault takes no test stand-in. */
const CLOUDFLARE_AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/";
const CLOUDFLARE_TOKEN_HEADER = "cf-aig-authorization";
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
/** Headers the vault keeps for itself (`x-agw-vault`, `x-agw-vault-error`): never taken from a provider's answer. */
const RESERVED_HEADER = /^x-agw-vault/iu;
const SECRET_CACHE_TTL_MS = 10 * 60_000;
const SECRET_CACHE_MAX = 10_000;

/** @type {Map<string, { value: string, at: number }>} */
const openedCache = new Map();

/**
 * A credential, opened once and kept in this isolate for a while, by the blob
 * and the whole identity it opened under: a rotated key is never served from
 * the cache, and neither is one asked for under another address.
 * @param {VaultEnv} env
 * @param {"providerKey" | "cloudflareGatewayToken"} kind
 * @param {readonly string[]} identity
 * @param {string} blob
 */
async function opened(env, kind, identity, blob) {
  const key = [kind, ...identity, blob].join("\u0000");
  const cached = openedCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < SECRET_CACHE_TTL_MS) return cached.value;
  const value = await open(env, kind, identity, blob);
  openedCache.delete(key);
  if (openedCache.size >= SECRET_CACHE_MAX) {
    const oldest = openedCache.keys().next().value;
    if (oldest !== undefined) openedCache.delete(oldest);
  }
  openedCache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * The address to send to, when `url` is under `base` and nothing in it can
 * reach another host or climb out of `base`'s path; else null. `url` must
 * start with `base` as written, and still be under it once parsed: a `..`,
 * a `\`, an encoded dot segment or a user part that would move it elsewhere
 * after parsing is refused.
 * @param {string} url
 * @param {string} base
 * @returns {string | null}
 */
export function under(url, base) {
  if (!base.endsWith("/") || !url.startsWith(base)) return null;
  /** @type {URL} */
  let parsed;
  /** @type {URL} */
  let root;
  try {
    parsed = new URL(url);
    root = new URL(base);
  } catch {
    return null;
  }
  if (root.protocol !== "https:" || parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "" || root.username !== "" || root.password !== "") return null;
  if (parsed.origin !== root.origin) return null;
  if (!parsed.pathname.startsWith(root.pathname)) return null;
  // What follows the base, as written: a backslash or a dot segment is read differently by different servers.
  const rest = url.slice(base.length).split(/[?#]/u, 1)[0] ?? "";
  if (rest.includes("\\")) return null;
  if (rest.split("/").some((segment) => /^(?:\.|%2e){1,2}$/iu.test(segment))) return null;
  return parsed.href;
}

/**
 * Where a call may go with these credentials, or null. A provider key goes
 * only under the address it is sealed for, or, sealed for "", only to its
 * provider type's own hosts. A Cloudflare token goes only under the account
 * and gateway it is sealed for. With both, both must allow it.
 * @param {string} url
 * @param {SealedCredentials} credentials
 * @returns {string | null}
 */
export function allowedUrl(url, credentials) {
  /** @type {string | null} */
  let target = null;
  const key = credentials.providerKey;
  const token = credentials.cloudflareToken;
  if (key === undefined && token === undefined) return null;
  if (key !== undefined) {
    const [, , providerType = "", baseUrl = ""] = key.identity;
    if (baseUrl !== "") {
      target = under(url, baseUrl);
    } else {
      const hosts = Object.hasOwn(PROVIDER_HOSTS, providerType) ? PROVIDER_HOSTS[/** @type {keyof typeof PROVIDER_HOSTS} */ (providerType)] : [];
      for (const host of hosts) {
        target = under(url, `https://${host}/`);
        if (target !== null) break;
      }
    }
    if (target === null) return null;
  }
  if (token !== undefined) {
    const [, , gatewayAccountId = "", gatewayId = ""] = token.identity;
    if (gatewayAccountId === "" || gatewayId === "") return null;
    const base = `${CLOUDFLARE_AI_GATEWAY_ORIGIN}v1/${encodeURIComponent(gatewayAccountId)}/${encodeURIComponent(gatewayId)}/`;
    const gatewayTarget = under(url, base);
    if (gatewayTarget === null || (target !== null && gatewayTarget !== target)) return null;
    target = gatewayTarget;
  }
  return target;
}

/**
 * The sealed credentials a call carries, read from what the gateway sent, or null when they are not well formed.
 * @param {unknown} value
 * @returns {SealedCredentials | null}
 */
export function readCredentials(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {{ providerKey?: SealedKey, cloudflareToken?: SealedToken }} */
  const credentials = {};
  /** @param {unknown} item */
  const identityOf = (item) => (Array.isArray(item) && item.length === 4 && item.every((id) => typeof id === "string") ? /** @type {string[]} */ (item) : null);
  if (record.providerKey !== undefined) {
    const key = /** @type {Record<string, unknown>} */ (record.providerKey ?? {});
    const identity = identityOf(key.identity);
    if (typeof key.blob !== "string" || identity === null || typeof key.header !== "string" || typeof key.format !== "string") return null;
    if (!HEADER_NAME.test(key.header) || !key.format.includes("{key}") || key.format.length > 256) return null;
    credentials.providerKey = { blob: key.blob, identity, header: key.header, format: key.format };
  }
  if (record.cloudflareToken !== undefined) {
    const token = /** @type {Record<string, unknown>} */ (record.cloudflareToken ?? {});
    const identity = identityOf(token.identity);
    if (typeof token.blob !== "string" || identity === null) return null;
    credentials.cloudflareToken = { blob: token.blob, identity };
  }
  if (credentials.providerKey === undefined && credentials.cloudflareToken === undefined) return null;
  return credentials;
}

/**
 * The vault's own answer: no body, a code a log line can name.
 * @param {string} code
 */
function refuse(code) {
  console.log(JSON.stringify({ level: "error", message: "vault_call_refused", code }));
  return new Response(null, { status: 502, headers: { [VAULT_ERROR_HEADER]: code } });
}

/**
 * Sends one call to a provider with its sealed credentials.
 * @param {VaultEnv} env
 * @param {VaultCall} call
 * @returns {Promise<Response>}
 */
export async function callProvider(env, call) {
  const credentials = readCredentials(call.credentials);
  if (credentials === null) return refuse("bad_request");
  const target = allowedUrl(call.url, credentials);
  if (target === null) return refuse("destination_refused");
  const headers = new Headers(call.headers);
  headers.delete(CALL_HEADER);
  /** @type {string[]} */
  const keyHeaders = [];
  try {
    if (credentials.providerKey !== undefined) {
      const { blob, identity, header, format } = credentials.providerKey;
      const key = await opened(env, "providerKey", identity, blob);
      // A callback, so a key with `$&` is sent as it is.
      headers.set(header, format.replace("{key}", () => key));
      keyHeaders.push(header.toLowerCase());
    }
    if (credentials.cloudflareToken !== undefined) {
      const { blob, identity } = credentials.cloudflareToken;
      const token = await opened(env, "cloudflareGatewayToken", identity, blob);
      headers.set(CLOUDFLARE_TOKEN_HEADER, `Bearer ${token}`);
      keyHeaders.push(CLOUDFLARE_TOKEN_HEADER);
    }
  } catch (error) {
    if (error instanceof VaultConfigurationError) return refuse("misconfigured");
    if (error instanceof VaultBlobError) return refuse("credential_unavailable");
    return refuse("credential_unavailable");
  }
  /** @type {RequestInit} */
  const init = {
    method: call.method,
    headers,
    body: call.method === "GET" || call.method === "HEAD" ? null : call.body,
    // Never follow a redirect: it could take the key to another host.
    redirect: "manual",
  };
  if (call.signal !== undefined) init.signal = call.signal;
  const upstream = await fetch(target, init);
  // The key header never goes back, whatever the provider echoed.
  // The key header never goes back, whatever the provider echoed, and neither does
  // a header the vault keeps for itself: a provider cannot fake a vault refusal.
  const names = [...upstream.headers.keys()];
  const dropped = names.filter((name) => keyHeaders.includes(name) || RESERVED_HEADER.test(name));
  if (dropped.length === 0) return upstream;
  const answer = new Response(upstream.body, upstream);
  for (const name of dropped) answer.headers.delete(name);
  return answer;
}

/**
 * A call as it arrives over the service binding: the request the gateway
 * built, with the sealed credentials in `x-agw-vault`.
 * @param {VaultEnv} env
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function callFromRequest(env, request) {
  const raw = request.headers.get(CALL_HEADER);
  /** @type {unknown} */
  let credentials = null;
  try {
    credentials = raw === null ? null : JSON.parse(raw);
  } catch {
    return refuse("bad_request");
  }
  return callProvider(env, {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    credentials: /** @type {SealedCredentials} */ (credentials),
  });
}

/**
 * Which of `texts` hold one of these credentials, opened here: for the
 * gateway's stored conversations, which never keep a body that echoes a key
 * the call carried. Only yes or no goes back; a key shorter than 8 characters
 * is not looked for, as it would match ordinary text.
 * @param {VaultEnv} env
 * @param {unknown} sealed
 * @param {unknown} texts
 * @returns {Promise<boolean[]>}
 */
export async function holds(env, sealed, texts) {
  const credentials = readCredentials(sealed);
  if (credentials === null || !Array.isArray(texts) || !texts.every((text) => typeof text === "string")) throw new VaultBlobError("bad request");
  /** @type {string[]} */
  const secrets = [];
  if (credentials.providerKey !== undefined) {
    const { blob, identity } = credentials.providerKey;
    secrets.push(await opened(env, "providerKey", identity, blob));
  }
  if (credentials.cloudflareToken !== undefined) {
    const { blob, identity } = credentials.cloudflareToken;
    secrets.push(await opened(env, "cloudflareGatewayToken", identity, blob));
  }
  const long = secrets.filter((secret) => secret.length >= 8);
  return /** @type {string[]} */ (texts).map((text) => long.some((secret) => text.includes(secret)));
}
