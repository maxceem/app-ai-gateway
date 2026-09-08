const APP_ID_MAX_LENGTH = 63;
/** Mirrors `APP_ID_SUFFIX_LENGTH` in `src/routes/admin/apps.ts`. */
const APP_ID_SUFFIX_LENGTH = 6;

/**
 * Stands in for the suffix the gateway will draw. One character per character
 * of the real suffix, so the preview is the same shape as the id that will
 * exist — and unmistakably not a value anyone can copy and use.
 */
export const APP_ID_SUFFIX_PLACEHOLDER = "•".repeat(APP_ID_SUFFIX_LENGTH);

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
 * What the id will read like, for a name that has not been submitted yet.
 *
 * The console cannot know the id: the gateway mints it, suffix and all, when
 * the app is created. It can show the readable half, trimmed exactly as the
 * server trims it, so a long name does not promise a stem that will be cut.
 */
export function appIdPreview(name: string): string {
  const stem = slugifyAppName(name)
    .slice(0, APP_ID_MAX_LENGTH - APP_ID_SUFFIX_LENGTH - 1)
    .replace(/-+$/u, "");
  return `${stem}-${APP_ID_SUFFIX_PLACEHOLDER}`;
}
