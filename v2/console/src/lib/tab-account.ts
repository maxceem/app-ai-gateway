import { CONSOLE_ACCOUNT_HEADER } from "@contracts/access";
import { isAccountId } from "./auth-redirect";

/**
 * The account this browser tab acts in.
 *
 * Each tab keeps its own account and names it on every management call
 * (`x-account-id`), so switching accounts in one tab never moves another. The
 * gateway's shared cookie only picks the account a new tab opens on: a tab
 * with no account yet sends no header, and takes the account the session
 * answers with.
 *
 * It is kept in `sessionStorage`, which is per tab, so a reload stays on the
 * same account. A tab with no account yet opens on the one a checkout return
 * names, if the person is an active member of it (`readSession`). An id of
 * the wrong shape, from the address or from storage, is ignored.
 *
 * `setTabAccount` is the only way it changes: an explicit switch, a tab
 * opening, the fallback when the account named is no longer the person's,
 * and signing out.
 */
const STORE_KEY = "agw.tab-account";

/** Undefined until first read: worked out then, not on import (`./auth-redirect` and `./api` import each other). */
let current: string | null | undefined;

function opening(): string | null {
  try {
    const stored = sessionStorage.getItem(STORE_KEY);
    if (isAccountId(stored)) return stored;
    if (stored !== null) sessionStorage.removeItem(STORE_KEY);
  } catch {
    // No storage: the tab opens on the session's account.
  }
  return null;
}

function store(accountId: string | null): void {
  try {
    if (accountId === null) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, accountId);
  } catch {
    // No storage (a private window, say): the tab still keeps it in memory.
  }
}

/** The account this tab acts in, or null before it has opened on one. */
export function tabAccount(): string | null {
  if (current === undefined) current = opening();
  return current;
}

/** Sets the account this tab acts in; null forgets it (signing out). */
export function setTabAccount(accountId: string | null): void {
  current = isAccountId(accountId) ? accountId : null;
  store(current);
}

/** The address's query string, where a checkout return or the sign-in page carrying one names its account. */
export function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/** Adds this tab's account to a request's headers, unless the request names one itself. */
export function withTabAccount(headers: Headers): Headers {
  const account = tabAccount();
  if (account !== null && !headers.has(CONSOLE_ACCOUNT_HEADER)) headers.set(CONSOLE_ACCOUNT_HEADER, account);
  return headers;
}

/** Tests only: forgets the tab's account, so the next read works it out afresh from the address and storage. */
export function resetTabAccountForTests(): void {
  current = undefined;
  store(null);
}
