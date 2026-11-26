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
import { CLOUDFLARE_SLUGS, KEY_HEADERS, PROVIDER_HOSTS } from "./hosts.js";
import { keyForRequest, readRequestCredential } from "./keys.js";
import { VaultBlobError, VaultConfigurationError, sealAs } from "./seal.js";

/** @typedef {import("./seal.js").VaultEnv} VaultEnv */

/**
 * A provider key, sealed. For a built-in type, the header and format the
 * gateway names for the call (one of the type's own key headers); a custom
 * provider's key goes where it was sealed to go, and these are ignored.
 * A copy stored for work with no app request has one more id, when it stops
 * opening (`storedProviderKey`).
 * @typedef {{ readonly blob: string, readonly identity: readonly string[], readonly header?: string, readonly format?: string }} SealedKey
 */
/**
 * A Cloudflare AI Gateway token, sealed. A stored copy has one more id, as above.
 * @typedef {{ readonly blob: string, readonly identity: readonly string[] }} SealedToken
 */
/**
 * What a call carries, sealed. At least one of the two keys is set.
 * `credential` is the app's own, for an account with split keys on.
 * @typedef {{ readonly providerKey?: SealedKey, readonly cloudflareToken?: SealedToken, readonly credential?: import("./keys.js").RequestCredential }} SealedCredentials
 */
/**
 * @typedef {{
 *   readonly url: string,
 *   readonly method: string,
 *   readonly headers: Headers,
 *   readonly body: BodyInit | null,
 *   readonly signal?: AbortSignal,
 *   readonly deadline?: number,
 *   readonly credentials: SealedCredentials,
 * }} VaultCall
 *
 * `deadline` is when the caller gives up, in epoch ms: the vault stops waiting
 * on cf-kms half a second before it, so its own refusal arrives first.
 */

/** The request header the sealed credentials travel in over the service binding. */
export const CALL_HEADER = "x-agw-vault";
/** Set on an answer the vault itself gives, never on a provider's. Its value is a code. */
export const VAULT_ERROR_HEADER = "x-agw-vault-error";
/** The caller's deadline, in epoch ms, over the service binding (`VaultCall.deadline`). */
export const DEADLINE_HEADER = "x-agw-vault-deadline";
/** How long before the caller's deadline the vault stops waiting on cf-kms. */
const DEADLINE_MARGIN_MS = 500;

/** Cloudflare AI Gateway's own origin. Only Cloudflare's: the vault takes no test stand-in. */
const CLOUDFLARE_AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/";
const CLOUDFLARE_TOKEN_HEADER = "cf-aig-authorization";
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]{1,100}$/u;
/** Headers the vault keeps for itself (`x-agw-vault`, `x-agw-vault-error`): never taken from a provider's answer. */
const RESERVED_HEADER = /^x-agw-vault/iu;
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
 * Whether a built-in type's key may be sent in `header`: only in a header
 * its own provider takes keys in. A header such as `origin` could come back
 * in an answer (`access-control-allow-origin`) with the key, and fal passes
 * other headers on to the apps it runs. A custom provider's key is never
 * placed by the caller: it goes in the header sealed with it (`keyPlacement`).
 * @param {string} providerType
 * @param {string} header lower-cased
 */
export function keyHeaderAllowed(providerType, header) {
  if (!Object.hasOwn(KEY_HEADERS, providerType)) return false;
  return /** @type {readonly string[]} */ (KEY_HEADERS[/** @type {keyof typeof KEY_HEADERS} */ (providerType)]).includes(header);
}

/**
 * Where a provider key goes in the request. A built-in type's: the header
 * the gateway names for the call's API style, if it is one of the type's own
 * key headers, and nothing sealed with the key. A custom provider's: only the
 * header and format sealed with the key when it was saved; whatever the
 * caller names is ignored, so no header a proxy might reflect back can be
 * chosen for it. Null when neither holds.
 * @param {readonly string[]} identity
 * @param {unknown} header
 * @param {unknown} format
 * @returns {{ header: string, format: string } | null}
 */
export function keyPlacement(identity, header, format) {
  const [, , providerType = "", , sealedHeader = "", sealedFormat = ""] = identity;
  if (Object.hasOwn(PROVIDER_HOSTS, providerType)) {
    if (sealedHeader !== "" || sealedFormat !== "") return null;
    if (typeof header !== "string" || typeof format !== "string") return null;
    if (format.split("{key}").length !== 2 || format.length > 256) return null;
    return keyHeaderAllowed(providerType, header.toLowerCase()) ? { header: header.toLowerCase(), format } : null;
  }
  if (!HEADER_NAME.test(sealedHeader) || sealedFormat.split("{key}").length !== 2) return null;
  return { header: sealedHeader, format: sealedFormat };
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
    if (baseUrl.startsWith(CLOUDFLARE_AI_GATEWAY_ORIGIN)) {
      // Sealed for a Cloudflare AI Gateway: only under this provider's own path there.
      const slug = Object.hasOwn(CLOUDFLARE_SLUGS, providerType) ? CLOUDFLARE_SLUGS[/** @type {keyof typeof CLOUDFLARE_SLUGS} */ (providerType)] : undefined;
      target = slug === undefined ? null : under(url, `${baseUrl}${slug}/`);
    } else if (baseUrl !== "") {
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
 * Without `placement` (a stored copy, which sends nothing), a provider key needs no header.
 * @param {unknown} value
 * @param {{ placement?: boolean }} [options]
 * @returns {SealedCredentials | null}
 */
export function readCredentials(value, options = {}) {
  if (typeof value !== "object" || value === null) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {{ providerKey?: SealedKey, cloudflareToken?: SealedToken, credential?: import("./keys.js").RequestCredential }} */
  const credentials = {};
  /** @param {unknown} item @param {number} length A stored copy has one more id. */
  const identityOf = (item, length) =>
    Array.isArray(item) && (item.length === length || item.length === length + 1) && item.every((id) => typeof id === "string")
      ? /** @type {string[]} */ (item)
      : null;
  if (record.providerKey !== undefined) {
    const key = /** @type {Record<string, unknown>} */ (record.providerKey ?? {});
    const identity = identityOf(key.identity, 6);
    if (typeof key.blob !== "string" || identity === null) return null;
    if (options.placement === false) {
      credentials.providerKey = { blob: key.blob, identity };
    } else {
      const placement = keyPlacement(identity, key.header, key.format);
      if (placement === null) return null;
      credentials.providerKey = { blob: key.blob, identity, ...placement };
    }
  }
  if (record.cloudflareToken !== undefined) {
    const token = /** @type {Record<string, unknown>} */ (record.cloudflareToken ?? {});
    const identity = identityOf(token.identity, 4);
    if (typeof token.blob !== "string" || identity === null) return null;
    credentials.cloudflareToken = { blob: token.blob, identity };
  }
  if (credentials.providerKey === undefined && credentials.cloudflareToken === undefined) return null;
  try {
    const credential = readRequestCredential(record.credential);
    if (credential !== null) credentials.credential = credential;
  } catch {
    return null;
  }
  return credentials;
}

/** The kind a sealed provider key opens as: a stored copy has one more id. @param {SealedKey} key */
function keyKind(key) {
  return key.identity.length === 7 ? "storedProviderKey" : "providerKey";
}

/** The kind a sealed Cloudflare token opens as. @param {SealedToken} token */
function tokenKind(token) {
  return token.identity.length === 5 ? "storedCloudflareToken" : "cloudflareGatewayToken";
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
  headers.delete(DEADLINE_HEADER);
  // One wait for both credentials, ending before the caller gives up.
  const until = call.deadline === undefined ? undefined : call.deadline - DEADLINE_MARGIN_MS;
  /** @type {string[]} */
  const keyHeaders = [];
  /** @type {import("./keys.js").CallMemo} */
  const memo = {};
  const options = { credential: credentials.credential ?? null, memo, ...(call.signal ? { signal: call.signal } : {}), ...(until === undefined ? {} : { until }) };
  try {
    if (credentials.providerKey !== undefined) {
      // `readCredentials` has set the placement: the type's own key header, or the sealed one.
      const { blob, identity, header = "", format = "" } = credentials.providerKey;
      const key = await keyForRequest(env, keyKind(credentials.providerKey), identity, blob, options);
      // A callback, so a key with `$&` is sent as it is.
      headers.set(header, format.replace("{key}", () => key));
      keyHeaders.push(header.toLowerCase());
    }
    if (credentials.cloudflareToken !== undefined) {
      const { blob, identity } = credentials.cloudflareToken;
      const token = await keyForRequest(env, tokenKind(credentials.cloudflareToken), identity, blob, options);
      headers.set(CLOUDFLARE_TOKEN_HEADER, `Bearer ${token}`);
      keyHeaders.push(CLOUDFLARE_TOKEN_HEADER);
    }
    // The caller's time may have run out while the key was opened: then nothing is sent.
    call.signal?.throwIfAborted();
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
  const deadline = Number(request.headers.get(DEADLINE_HEADER) ?? "");
  return callProvider(env, {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    ...(Number.isFinite(deadline) && deadline > 0 ? { deadline } : {}),
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
  const options = { credential: credentials.credential ?? null, memo: {} };
  if (credentials.providerKey !== undefined) {
    const { blob, identity } = credentials.providerKey;
    secrets.push(await keyForRequest(env, keyKind(credentials.providerKey), identity, blob, options));
  }
  if (credentials.cloudflareToken !== undefined) {
    const { blob, identity } = credentials.cloudflareToken;
    secrets.push(await keyForRequest(env, tokenKind(credentials.cloudflareToken), identity, blob, options));
  }
  const long = secrets.filter((secret) => secret.length >= 8);
  return /** @type {string[]} */ (texts).map((text) => long.some((secret) => text.includes(secret)));
}

/** The longest a stored copy may be kept: fal's job checks need about 62 minutes, a session's lookups up to about 2 hours. */
export const MAX_STORED_COPY_MS = 3 * 60 * 60_000;

/**
 * Copies of a call's credentials for work that runs later with no app
 * request (plan step 8j, "Keys needed with no app request"): opened here with
 * the app's credential, and sealed with the KEK alone, bound to the same ids
 * and to `expiresAt`, after which they never open. The gateway stores them
 * on the job's row and deletes them with it. A copy is never copied again.
 * @param {VaultEnv} env
 * @param {unknown} sealed
 * @param {unknown} expiresAt epoch ms
 * @returns {Promise<{ providerKey?: { blob: string, identity: string[] }, cloudflareToken?: { blob: string, identity: string[] } }>}
 */
export async function storeCopy(env, sealed, expiresAt) {
  const credentials = readCredentials(sealed, { placement: false });
  if (credentials === null) throw new VaultBlobError("bad request");
  const now = Date.now();
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_STORED_COPY_MS) {
    throw new VaultBlobError("a stored copy's expiry must be within the next 3 hours");
  }
  const key = credentials.providerKey;
  const token = credentials.cloudflareToken;
  if ((key !== undefined && keyKind(key) !== "providerKey") || (token !== undefined && tokenKind(token) !== "cloudflareGatewayToken")) {
    throw new VaultBlobError("a stored copy is never copied again");
  }
  const options = { credential: credentials.credential ?? null, memo: {} };
  const until = String(expiresAt);
  /** @type {{ providerKey?: { blob: string, identity: string[] }, cloudflareToken?: { blob: string, identity: string[] } }} */
  const copies = {};
  if (key !== undefined) {
    const identity = [...key.identity, until];
    copies.providerKey = { blob: await sealAs(env, "storedProviderKey", identity, await keyForRequest(env, "providerKey", key.identity, key.blob, options)), identity };
  }
  if (token !== undefined) {
    const identity = [...token.identity, until];
    copies.cloudflareToken = {
      blob: await sealAs(env, "storedCloudflareToken", identity, await keyForRequest(env, "cloudflareGatewayToken", token.identity, token.blob, options)),
      identity,
    };
  }
  return copies;
}
