import { describe, expect, it } from "vitest";
import headersFile from "../public/_headers?raw";

/**
 * The console's static response headers, as Workers Static Assets applies
 * them from `console/public/_headers`.
 *
 * The OAuth consent page and the key reveal page rely on these rather than on
 * a rule of their own: either can be reached by client-side navigation — from
 * `/login?from=…` after signing in, say — which loads no document whose path a
 * narrower rule could match. So the frame protection is one rule for every
 * path, and this keeps anyone from narrowing it.
 */

interface Rule {
  path: string;
  headers: Record<string, string>;
}

function rules(text: string): Rule[] {
  const parsed: Rule[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      parsed.push({ path: line.trim(), headers: {} });
      continue;
    }
    const [name, ...value] = line.trim().split(":");
    parsed.at(-1)!.headers[name!.trim().toLowerCase()] = value.join(":").trim();
  }
  return parsed;
}

const HEADERS = rules(headersFile);

describe("console response headers", () => {
  it("forbids framing on every console path", () => {
    const global = HEADERS.find((rule) => rule.path === "/*");
    expect(global?.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(global?.headers["x-frame-options"]).toBe("DENY");
  });

  it("has no path-specific frame rule that could be mistaken for the protection", () => {
    for (const rule of HEADERS.filter((candidate) => candidate.path !== "/*")) {
      expect(rule.headers, rule.path).not.toHaveProperty("content-security-policy");
      expect(rule.headers, rule.path).not.toHaveProperty("x-frame-options");
    }
  });
});
