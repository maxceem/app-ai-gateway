import { CONSOLE_ACCOUNT_HEADER } from "@contracts/access";
import { checkoutAccountFrom, checkoutSucceeded } from "./auth-redirect";

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
 * same account. A checkout return names the account it was for, and the tab
 * opens on that account (the gateway checks the person is a member).
 */
const STORE_KEY = "agw.tab-account";

/** Undefined until first read: worked out then, not on import (`./auth-redirect` and `./api` import each other). */
let current: string | null | undefined;

function opening(): string | null {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const returned = checkoutSucceeded(search) ? checkoutAccountFrom(search) : null;
  if (returned !== null) {
    store(returned);
    return returned;
  }
  try {
    return sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
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
  current = accountId;
  store(accountId);
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
