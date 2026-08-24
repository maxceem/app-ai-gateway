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

/**
 * Whether `actorRole` may remove the member holding `targetRole`.
 *
 * Mirrors cf-auth's `removeOrganizationMember`, which gates on manager rights,
 * owner-acts-on-owner, and the last-owner guard — and imposes no special rule
 * for removing yourself. Self-removal is therefore allowed on the same terms as
 * removing anyone else; the UI presents it as leaving rather than removing.
 */
export function canRemoveMember(input: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  ownerCount: number;
  isSelf: boolean;
}): RoleChangeCheck {
  const { actorRole, targetRole, ownerCount, isSelf } = input;

  if (!canManage(actorRole)) {
    // A plain member fails cf-auth's `requireManager`, so they cannot even leave.
    return {
      allowed: false,
      reason: isSelf
        ? "Only owners and admins can leave on their own. Ask one of them to remove you."
        : READ_ONLY_REASON,
    };
  }
  if (targetRole === "owner" && !canActOnOwners(actorRole)) {
    return { allowed: false, reason: "Only an owner can remove another owner." };
  }
  if (targetRole === "owner" && ownerCount <= 1) {
    return {
      allowed: false,
      reason: isSelf
        ? "You are the last owner. Promote another owner before leaving."
        : "An organization must keep at least one owner.",
    };
  }

  return { allowed: true };
}

/** The org switcher is noise until the operator actually belongs to more than one. */
export function shouldShowOrganizationSwitcher(membershipCount: number): boolean {
  return membershipCount > 1;
}
