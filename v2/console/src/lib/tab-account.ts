import { CONSOLE_ACCOUNT_HEADER } from "@contracts/access";
import { CHECKOUT_PATH, consoleUrl, isAccountId, routerPath } from "./auth-redirect";

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
 * `setTabAccount` is the only way it changes. A tab opening saves the
 * account it loaded; signing out forgets it (an expired session keeps it).
 * Any other change, an explicit switch, the fallback when the account named
 * is no longer the person's, or a checkout return's account, goes through
 * `switchTabAccount`, which reloads the page on the new account: nothing is
 * swapped in place.
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

/**
 * Whether this page is switching account. From the start of a switch until
 * the page reloads, it sends no new request (`./api` refuses them) and takes
 * no input (the shell is inert): the page still shows the account it is
 * leaving, while the tab's saved account may already be the next one.
 */
let switching = false;
const switchListeners = new Set<() => void>();

export function isSwitchingAccount(): boolean {
  return switching;
}

export function onSwitchingAccount(listener: () => void): () => void {
  switchListeners.add(listener);
  return () => switchListeners.delete(listener);
}

function setSwitching(value: boolean): void {
  if (switching === value) return;
  switching = value;
  for (const listener of switchListeners) listener();
}

/** A switch has started: the page stops sending requests and taking input. */
export function beginAccountSwitch(): void {
  setSwitching(true);
}

/** The switch request failed: the page carries on with the account it has. */
export function cancelAccountSwitch(): void {
  setSwitching(false);
}

/** Set once the page has been sent away: a second switch on the same page loads nothing more. */
let switchedAlready = false;

/**
 * Saves the tab's new account (null: the one the session selects) and loads
 * the page again on it, once. On the checkout landing, the page goes to
 * Billing instead, so a checkout meant for the account left never starts for
 * the new one.
 */
export function switchTabAccount(accountId: string | null): void {
  setTabAccount(accountId);
  if (switchedAlready) return;
  switchedAlready = true;
  setSwitching(true);
  if (routerPath(window.location.pathname) === CHECKOUT_PATH) window.location.assign(consoleUrl("/billing"));
  else window.location.reload();
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
  switching = false;
  switchedAlready = false;
}

/** Tests only: the tab as a reload finds it, its account worked out again from storage. */
export function reopenTabForTests(): void {
  current = undefined;
  switching = false;
  switchedAlready = false;
}
