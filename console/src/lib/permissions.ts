import type { OrganizationRole } from "./types";

/**
 * Mirrors the gateway's own rules so the console can disable an action before
 * the request rather than after a 403. The server stays authoritative; this
 * only decides what the UI offers.
 */

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Owners and admins may mutate gateway resources; members are read-only. */
export function canManage(role: OrganizationRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export const READ_ONLY_REASON =
  "Your role in this organization is read-only. Ask an owner or admin to make this change.";

/** The org switcher is noise until the operator actually belongs to more than one. */
export function shouldShowOrganizationSwitcher(membershipCount: number): boolean {
  return membershipCount > 1;
}
