import { describe, expect, it } from "vitest";
import { isValidAppId, slugifyAppName, uniqueAppId } from "./app-id";

describe("application ids", () => {
  it("derives a lowercase URL-safe id from the display name", () => {
    expect(slugifyAppName("  Café Companion — iOS  ")).toBe("cafe-companion-ios");
    expect(slugifyAppName("健康助手")).toBe("app");
  });

  it("adds a short suffix when the derived id already exists", () => {
    expect(uniqueAppId("Calorie Tracker", ["calorie-tracker"], () => "x7K3")).toBe(
      "calorie-tracker-x7k3",
    );
  });

  it("keeps generated ids within the gateway format", () => {
    const id = uniqueAppId("A".repeat(100), ["a".repeat(63)], () => "1a2b");
    expect(id).toHaveLength(63);
    expect(isValidAppId(id)).toBe(true);
  });
});
