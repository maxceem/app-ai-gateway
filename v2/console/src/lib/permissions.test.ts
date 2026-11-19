import { describe, expect, it } from "vitest";
import { canManage, shouldShowAccountSwitcher } from "./permissions";

describe("canManage", () => {
  it("treats owners and admins as mutators and members as read-only", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(null)).toBe(false);
  });
});

describe("shouldShowAccountSwitcher", () => {
  it("hides the switcher until there is something to switch between", () => {
    expect(shouldShowAccountSwitcher(0)).toBe(false);
    expect(shouldShowAccountSwitcher(1)).toBe(false);
    expect(shouldShowAccountSwitcher(2)).toBe(true);
  });
});
