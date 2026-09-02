import { describe, expect, it } from "vitest";
import { canManage, shouldShowOrganizationSwitcher } from "./permissions";

describe("canManage", () => {
  it("treats owners and admins as mutators and members as read-only", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(null)).toBe(false);
  });
});

describe("shouldShowOrganizationSwitcher", () => {
  it("hides the switcher until there is something to switch between", () => {
    expect(shouldShowOrganizationSwitcher(0)).toBe(false);
    expect(shouldShowOrganizationSwitcher(1)).toBe(false);
    expect(shouldShowOrganizationSwitcher(2)).toBe(true);
  });
});
