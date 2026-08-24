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

export const ASSIGNABLE_ROLES: OrganizationRole[] = ["owner", "admin", "member"];

/** Owners and admins may mutate gateway resources; members are read-only. */
export function canManage(role: OrganizationRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Only an owner may grant the owner role, demote an owner, or remove one. */
export function canActOnOwners(role: OrganizationRole | null | undefined): boolean {
  return role === "owner";
}

export const READ_ONLY_REASON =
  "Your role in this organization is read-only. Ask an owner or admin to make this change.";

export interface RoleChangeCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Whether `actorRole` may move a member from `currentRole` to `nextRole`.
 * `ownerCount` guards the backend's last-owner rule (409 `last_owner`).
 */
export function canChangeRole(input: {
  actorRole: OrganizationRole;
  currentRole: OrganizationRole;
  nextRole: OrganizationRole;
  ownerCount: number;
}): RoleChangeCheck {
  const { actorRole, currentRole, nextRole, ownerCount } = input;

  if (currentRole === nextRole) return { allowed: false, reason: "Already assigned this role." };
  if (!canManage(actorRole)) return { allowed: false, reason: READ_ONLY_REASON };

  const grantingOwner = nextRole === "owner";
  const demotingOwner = currentRole === "owner";

  if ((grantingOwner || demotingOwner) && !canActOnOwners(actorRole)) {
    return { allowed: false, reason: "Only an owner can grant or remove the owner role." };
  }
  if (demotingOwner && ownerCount <= 1) {
    return { allowed: false, reason: "An organization must keep at least one owner." };
  }

  return { allowed: true };
}

/** Whether `actorRole` may remove a member holding `targetRole`. */
export function canRemoveMember(input: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  ownerCount: number;
  isSelf: boolean;
}): RoleChangeCheck {
  const { actorRole, targetRole, ownerCount, isSelf } = input;

  if (!canManage(actorRole)) return { allowed: false, reason: READ_ONLY_REASON };
  if (isSelf) return { allowed: false, reason: "You cannot remove yourself from the organization." };
  if (targetRole === "owner" && !canActOnOwners(actorRole)) {
    return { allowed: false, reason: "Only an owner can remove another owner." };
  }
  if (targetRole === "owner" && ownerCount <= 1) {
    return { allowed: false, reason: "An organization must keep at least one owner." };
  }

  return { allowed: true };
}

/** The org switcher is noise until the operator actually belongs to more than one. */
export function shouldShowOrganizationSwitcher(membershipCount: number): boolean {
  return membershipCount > 1;
}
