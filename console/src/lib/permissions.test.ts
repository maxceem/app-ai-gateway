import { describe, expect, it } from "vitest";
import {
  canActOnOwners,
  canChangeRole,
  canManage,
  canRemoveMember,
  shouldShowOrganizationSwitcher,
} from "./permissions";

describe("canManage", () => {
  it("treats owners and admins as mutators and members as read-only", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(null)).toBe(false);
  });

  it("reserves owner-level actions for owners", () => {
    expect(canActOnOwners("owner")).toBe(true);
    expect(canActOnOwners("admin")).toBe(false);
  });
});

describe("canChangeRole", () => {
  const base = { actorRole: "owner", currentRole: "member", nextRole: "admin", ownerCount: 2 } as const;

  it("lets an owner promote a member to admin", () => {
    expect(canChangeRole(base).allowed).toBe(true);
  });

  it("refuses a no-op change", () => {
    expect(canChangeRole({ ...base, nextRole: "member" }).allowed).toBe(false);
  });

  it("refuses every change for a read-only member", () => {
    const result = canChangeRole({ ...base, actorRole: "member" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/read-only/i);
  });

  it("stops an admin granting the owner role", () => {
    const result = canChangeRole({ ...base, actorRole: "admin", nextRole: "owner" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/only an owner/i);
  });

  it("stops an admin demoting an owner", () => {
    const result = canChangeRole({
      actorRole: "admin",
      currentRole: "owner",
      nextRole: "admin",
      ownerCount: 2,
    });
    expect(result.allowed).toBe(false);
  });

  it("protects the last owner even from another owner", () => {
    const result = canChangeRole({
      actorRole: "owner",
      currentRole: "owner",
      nextRole: "member",
      ownerCount: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/at least one owner/i);
  });

  it("allows demoting an owner while another remains", () => {
    expect(
      canChangeRole({
        actorRole: "owner",
        currentRole: "owner",
        nextRole: "admin",
        ownerCount: 2,
      }).allowed,
    ).toBe(true);
  });
});

describe("canRemoveMember", () => {
  const base = { actorRole: "owner", targetRole: "member", ownerCount: 2, isSelf: false } as const;

  it("lets an owner remove a plain member", () => {
    expect(canRemoveMember(base).allowed).toBe(true);
  });

  it("refuses self-removal", () => {
    const result = canRemoveMember({ ...base, isSelf: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/yourself/i);
  });

  it("refuses removal by a read-only member", () => {
    expect(canRemoveMember({ ...base, actorRole: "member" }).allowed).toBe(false);
  });

  it("stops an admin removing an owner", () => {
    expect(
      canRemoveMember({ ...base, actorRole: "admin", targetRole: "owner" }).allowed,
    ).toBe(false);
  });

  it("protects the last owner", () => {
    expect(
      canRemoveMember({ ...base, targetRole: "owner", ownerCount: 1 }).allowed,
    ).toBe(false);
  });
});

describe("shouldShowOrganizationSwitcher", () => {
  it("hides the switcher until there is something to switch between", () => {
    expect(shouldShowOrganizationSwitcher(0)).toBe(false);
    expect(shouldShowOrganizationSwitcher(1)).toBe(false);
    expect(shouldShowOrganizationSwitcher(2)).toBe(true);
  });
});
