const APP_ID_MAX_LENGTH = 63;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

export function uniqueAppId(
  name: string,
  existingIds: Iterable<string>,
  makeSuffix: () => string = randomSuffix,
): string {
  const existing = new Set(existingIds);
  const base = slugifyAppName(name);
  if (!existing.has(base)) return base;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const suffix = makeSuffix().toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 6) || "0000";
    const stem = base.slice(0, APP_ID_MAX_LENGTH - suffix.length - 1).replace(/-+$/u, "");
    const candidate = `${stem}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }

  // The API performs the same uniqueness check authoritatively. This fallback
  // remains valid even if a deterministic test suffix collides repeatedly.
  return `${base.slice(0, 56).replace(/-+$/u, "")}-${Date.now().toString(36).slice(-6)}`;
}

export function isValidAppId(id: string): boolean {
  return APP_ID.test(id);
}
