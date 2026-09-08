import { describe, expect, it } from "vitest";
import { APP_ID_SUFFIX_PLACEHOLDER, appIdPreview, slugifyAppName } from "./app-id";

describe("application ids", () => {
  it("derives a lowercase URL-safe stem from the display name", () => {
    expect(slugifyAppName("  Café Companion — iOS  ")).toBe("cafe-companion-ios");
    expect(slugifyAppName("健康助手")).toBe("app");
  });

  it("previews the stem plus a placeholder for the suffix the gateway assigns", () => {
    expect(appIdPreview("Calorie Tracker")).toBe(`calorie-tracker-${APP_ID_SUFFIX_PLACEHOLDER}`);
    expect(appIdPreview("健康助手")).toBe(`app-${APP_ID_SUFFIX_PLACEHOLDER}`);
  });

  it("trims the stem the way the server does, so the preview is not longer than the id", () => {
    // 63 characters is the id limit, and the suffix and its hyphen are part of it.
    expect(appIdPreview("A".repeat(100))).toHaveLength(63);
  });
});
