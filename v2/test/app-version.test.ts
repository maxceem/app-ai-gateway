import { describe, expect, it } from "vitest";
import { storedAppVersion } from "../src/core/app-version.ts";

describe("storedAppVersion", () => {
  // One table: what is kept as it was sent, and what is the caller's own text (Fable 7b-4).
  const cases: [string | null, string | null][] = [
    ["1.2.3", "1.2.3"],
    ["v1.2", "v1.2"],
    ["1", "1"],
    ["2024.11.1-beta.2", "2024.11.1-beta.2"],
    ["2024.11.22+45", "2024.11.22+45"],
    ["v2.0.0-beta.3", "v2.0.0-beta.3"],
    ["1.2.3 (45)", "1.2.3 (45)"],
    ["1.0 (1234567890)", "1.0 (1234567890)"],
    // Apple's build number may be dotted, and a CI tail may be long (Gemini Neon 7b-4).
    ["1.2.3 (1.2.3)", "1.2.3 (1.2.3)"],
    ["1.2.3 (2026.11.1)", "1.2.3 (2026.11.1)"],
    ["1.2.3-beta.1+20261122.1", "1.2.3-beta.1+20261122.1"],
    [`1.0-${"a".repeat(32)}`, `1.0-${"a".repeat(32)}`],
    [`1.0-${"a".repeat(33)}`, null],
    ["1.0 (1.2.3.4.5)", null],
    ["1.0 (1.beta)", null],
    ["1.0 (12345678901)", null],
    ["1.0 (key)", null],
    ["1.0 beta", null],
    ["0123456789abcdef0123456789abcdef", null],
    ["sk-proj-0123456789abcdef", null],
    ["9".repeat(100), null],
    ["1.2.3.4.5", null],
    ["", null],
    [null, null],
  ];
  it.each(cases)("%s → %s", (sent, kept) => {
    expect(storedAppVersion(sent)).toBe(kept);
  });
});
