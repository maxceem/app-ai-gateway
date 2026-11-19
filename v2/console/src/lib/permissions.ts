import type { AccountRole } from "./types";

/**
 * Mirrors the gateway's own rules so the console can disable an action before
 * the request rather than after a 403. The server stays authoritative; this
 * only decides what the UI offers.
 */

export const ROLE_LABELS: Record<AccountRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Owners and admins may change things; members are read-only. */
export function canManage(role: AccountRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export const READ_ONLY_REASON =
  "Your role is read-only. Ask an owner or admin to make this change.";

/** The account switcher is noise until the operator belongs to more than one. */
export function shouldShowAccountSwitcher(accountCount: number): boolean {
  return accountCount > 1;
}
