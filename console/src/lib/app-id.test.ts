import { describe, expect, it } from "vitest";
import {
  appIdSuffix,
  generatedAppId,
  isReservedAppId,
  isValidAppId,
  slugifyAppName,
} from "./app-id";

describe("application ids", () => {
  it("derives a lowercase URL-safe id from the display name", () => {
    expect(slugifyAppName("  Café Companion — iOS  ")).toBe("cafe-companion-ios");
    expect(slugifyAppName("健康助手")).toBe("app");
  });

  it("suffixes every generated id, whether or not anything collided", () => {
    expect(generatedAppId("Calorie Tracker", "k3f9x1")).toBe("calorie-tracker-k3f9x1");
    expect(generatedAppId("健康助手", "k3f9x1")).toBe("app-k3f9x1");
  });

  it("keeps generated ids within the gateway format", () => {
    const id = generatedAppId("A".repeat(100), "k3f9x1");
    expect(id).toHaveLength(63);
    expect(isValidAppId(id)).toBe(true);
  });

  it("draws a suffix that composes into a valid id", () => {
    const suffix = appIdSuffix();
    expect(suffix).toMatch(/^[0-9a-z]{6}$/u);
    expect(isValidAppId(generatedAppId("Chat", suffix))).toBe(true);
  });

  it("rejects the ids the gateway reserves", () => {
    expect(isReservedAppId("new")).toBe(true);
    expect(isReservedAppId("admin")).toBe(true);
    expect(isReservedAppId("calorie-tracker")).toBe(false);
    // Only an exact match is reserved, so a generated stem is never blocked.
    expect(isReservedAppId(generatedAppId("New", "k3f9x1"))).toBe(false);
  });
});
