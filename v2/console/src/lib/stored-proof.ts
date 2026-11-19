/**
 * A browser proof a page was handed in its URL's fragment, kept for this tab
 * only, for one page only, and only until it expires.
 *
 * The CLI's approval page and the OAuth consent page both strip the fragment
 * from the address bar on arrival and keep the proof here instead, under their
 * own path, so it survives a round trip through sign-in or Google — which
 * returns the browser to the same path without the fragment — and is sent to
 * nothing but the page's own API.
 */
export interface StoredProof {
  token: string;
  expiresAt: number;
}

export function readStoredProof(key: string): StoredProof | null {
  let stored: StoredProof | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(key) ?? "null") as StoredProof | null;
  } catch {
    stored = null;
  }
  if (!stored || typeof stored.token !== "string") return null;
  // A proof the gateway would refuse anyway is not worth keeping around.
  if (!(stored.expiresAt > Date.now())) {
    clearStoredProof(key);
    return null;
  }
  return stored;
}

export function writeStoredProof(key: string, value: StoredProof): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private modes refuse; the proof simply does not survive a redirect. */
  }
}

export function clearStoredProof(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Already unreachable. */
  }
}
