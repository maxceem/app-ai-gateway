/**
 * Validates an **operator-supplied** upstream base URL.
 *
 * ## Trust model
 *
 * Everywhere else in this codebase the upstream origin is a constant: provider
 * specs and gateway adapters own it, and `providerUpstream` documents that
 * clients never supply a URL. This module is the single, deliberate exception,
 * and it is scoped to a value that only an authenticated console operator (or a
 * management key holder) can write onto their own organization's provider row.
 * A gateway *client* — an iOS app, a server key — still cannot influence it in
 * any way: it is read from D1, never from a request.
 *
 * So the threat this guard answers is not "an attacker chose this URL". It is
 * "an operator typo, a copied-and-pasted internal address, or a compromised
 * console session turns this Worker into a probe of things it should not
 * reach". The rules below therefore fail closed on everything that is not
 * plainly a public, registrable, HTTPS endpoint.
 *
 * ## What is enforced
 *
 * - `https:` only, no credentials in the URL, no fragment, no query string.
 * - No explicit port other than 443 (the WHATWG URL parser normalizes an
 *   explicit `:443` away, so "no port survives parsing" is the same rule).
 * - The host must be a registrable public DNS name: no IP literals in any
 *   encoding, no single-label hosts, no trailing dot, no special-use suffix.
 * - A canonical form is stored: lower-case host, exactly one trailing `/`, and
 *   a sane length cap so the column can never hold something pathological.
 *
 * ## What this does NOT defend against, stated plainly
 *
 * - **DNS rebinding, and private addresses behind a public name.** A Worker
 *   cannot resolve a hostname itself, cannot pin the address it connects to,
 *   and cannot see which address `fetch` finally used. `evil.example.com` may
 *   resolve to `10.0.0.1`, or resolve differently on the second lookup. Any
 *   claim that this module blocks SSRF to private ranges would be false. What
 *   it blocks is the *direct* expression of such a target, which is what a
 *   mistake looks like; the actual control is that only operators can write it.
 * - **The reachability of anything the operator's own network exposes.** A
 *   public name pointed at an internal service is, from here, indistinguishable
 *   from a real provider.
 * - **What the endpoint does with the credential.** Pointing a row at an
 *   origin sends that row's provider key there. That is the operator's decision
 *   and the reason the field is operator-only.
 *
 * A public-suffix-list check was considered and rejected: it would add a
 * megabyte-scale dependency (or a network fetch) to a Worker for a rule that
 * only distinguishes `foo.co.uk` from `co.uk`, while the actual attacker in
 * this model already has console access. The label/suffix rules below give the
 * same practical protection against typos and internal names with no
 * dependency at all. If self-hosted *gateways* are ever funded, this module is
 * the prerequisite they reuse — that is why it is standalone.
 *
 * Deliberately import-free, in both directions: it pulls in nothing (not even
 * `GatewayError`, so the caller decides how a refusal is reported) and it is
 * safe to import from `src/contracts/schemas.ts`, which the OpenAPI generator
 * loads outside the Worker runtime.
 */

/** Long enough for a real Azure/vLLM origin with a path, short enough to bound. */
export const MAX_BASE_URL_LENGTH = 200;

/**
 * Top-level names that cannot be registered on the public internet, so a base
 * URL under one is either a local network address or a placeholder. RFC 6761 /
 * 6762 special-use names plus the common private conventions.
 */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
  "local",
  "localhost",
  "internal",
  "intranet",
  "private",
  "home",
  "lan",
  "corp",
  "domain",
  "alt",
  "onion",
  // `home.arpa` lives here; nothing under `.arpa` is an AI provider either way.
  "arpa",
  "invalid",
  "test",
  "example",
]);

/** One DNS label, punycode included; deliberately stricter than the URL parser. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A canonical IPv4 host. The URL parser resolves every encoding — `0x7f.1`,
 * `0177.0.0.1`, `2130706433` — into dotted decimal or fails outright, so
 * matching the canonical form catches all of them at once.
 */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** A host made only of digits and dots, whatever the URL parser made of it. */
const NUMERIC_HOST_PATTERN = /^[\d.]+$/u;

const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * Anything the WHATWG URL parser would quietly remove or reinterpret: ASCII
 * whitespace and C0 controls are stripped from the input, and a backslash is
 * read as a path separator for special schemes. Either would parse into a URL
 * the operator neither typed nor read, so both are refused on the raw string
 * before it is ever handed to the parser.
 */
function hasUnsafeCharacter(raw: string): boolean {
  for (const character of raw) {
    if (character === "\\") return true;
    const code = character.codePointAt(0)!;
    if (code <= SPACE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

export type BaseUrlCheck =
  | { ok: true; baseUrl: string }
  | { ok: false; message: string };

function reject(message: string): BaseUrlCheck {
  return { ok: false, message };
}

/**
 * Rejects a host that is not a registrable public DNS name. Returns the reason,
 * or `null` when the host passes.
 */
function hostProblem(hostname: string): string | null {
  // IPv6 literals arrive bracketed from the URL parser and are the only host
  // shape that can contain `[`.
  if (hostname.startsWith("[")) {
    return "Base URL must name a host, not an IPv6 address";
  }
  if (IPV4_PATTERN.test(hostname) || NUMERIC_HOST_PATTERN.test(hostname)) {
    return "Base URL must name a host, not an IP address";
  }
  if (hostname.endsWith(".")) {
    return "Base URL host must not end with a dot";
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return `Base URL host must be a public domain name; ${hostname} has no domain suffix`;
  }
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) {
      return `Base URL host contains an invalid DNS label: ${label || "(empty)"}`;
    }
  }
  const tld = labels[labels.length - 1]!;
  if (RESERVED_TLDS.has(tld)) {
    return `Base URL host .${tld} is a reserved local name, not a public endpoint`;
  }
  return null;
}

/**
 * Checks and canonicalizes an operator-supplied base URL. Every failure names
 * what is wrong rather than "invalid URL": the operator is the person who can
 * fix it, and they are looking at a form field.
 */
export function checkOperatorBaseUrl(input: string): BaseUrlCheck {
  const raw = input.trim();
  if (raw.length === 0) return reject("Base URL must not be empty");
  if (raw.length > MAX_BASE_URL_LENGTH) {
    return reject(`Base URL must be at most ${MAX_BASE_URL_LENGTH} characters`);
  }
  if (hasUnsafeCharacter(raw)) {
    return reject("Base URL must not contain whitespace, control characters, or backslashes");
  }
  if (raw.includes("@")) {
    return reject("Base URL must not contain credentials");
  }
  if (raw.includes("#")) {
    return reject("Base URL must not contain a fragment");
  }
  if (raw.includes("?")) {
    return reject("Base URL must not contain a query string");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("Base URL must be an absolute https:// URL");
  }

  if (url.protocol !== "https:") {
    return reject("Base URL must use https");
  }
  // Belt and braces with the `@` check above: userinfo can only appear there,
  // but this is the invariant that actually matters.
  if (url.username !== "" || url.password !== "") {
    return reject("Base URL must not contain credentials");
  }
  if (url.hash !== "" || url.search !== "") {
    return reject("Base URL must not contain a query string or fragment");
  }
  // An explicit `:443` is normalized away by the parser, so anything left is a
  // non-default port.
  if (url.port !== "") {
    return reject(`Base URL must use the default https port; port ${url.port} is not allowed`);
  }

  const problem = hostProblem(url.hostname);
  if (problem) return reject(problem);

  // Canonical form: the parser has already lower-cased and punycoded the host
  // and resolved `.` / `..` in the path; all that is left is the trailing
  // slash, so the path a request appends is always joined the same way.
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  const baseUrl = `https://${url.hostname}${path}`;
  if (baseUrl.length > MAX_BASE_URL_LENGTH) {
    return reject(`Base URL must be at most ${MAX_BASE_URL_LENGTH} characters`);
  }
  return { ok: true, baseUrl };
}
