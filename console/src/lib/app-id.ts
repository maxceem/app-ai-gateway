const APP_ID_MAX_LENGTH = 63;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const APP_ID_SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Mirrors `APP_ID_SUFFIX_LENGTH` in `src/routes/admin/apps.ts`. */
const APP_ID_SUFFIX_LENGTH = 6;

/**
 * Mirrors `RESERVED_APP_IDS` in `src/routes/admin/apps.ts`, so a custom id the
 * server would refuse is refused in the field instead of on submit.
 */
const RESERVED_APP_IDS = new Set([
  "admin", "api", "app", "apps", "assets", "auth", "billing", "console",
  "docs", "endpoints", "healthz", "keys", "login", "me", "new", "providers",
  "proxy", "settings", "signup", "static", "usage", "v1",
]);

export function slugifyAppName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, APP_ID_MAX_LENGTH)
    .replace(/-+$/u, "");

  return slug || "app";
}

/**
 * The random half of a generated id, drawn once per dialog rather than per
 * keystroke: the id on screen is the id that will be created, so it must not
 * change under the person reading it.
 */
export function appIdSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(APP_ID_SUFFIX_LENGTH));
  return Array.from(
    bytes,
    (byte) => APP_ID_SUFFIX_ALPHABET[byte % APP_ID_SUFFIX_ALPHABET.length],
  ).join("");
}

/**
 * The exact id the server will store, composed here so the console can show it
 * before the app exists. Every generated id is suffixed — the console does not
 * hand out bare stems any more than the server does, and the pair agree so that
 * what is displayed is what is created.
 */
export function generatedAppId(name: string, suffix: string): string {
  const stem = slugifyAppName(name)
    .slice(0, APP_ID_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/u, "");
  return `${stem}-${suffix}`;
}

export function isValidAppId(id: string): boolean {
  return APP_ID.test(id);
}

export function isReservedAppId(id: string): boolean {
  return RESERVED_APP_IDS.has(id);
}
