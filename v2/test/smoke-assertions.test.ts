/**
 * The smoke checks print nothing a deployment answered when they fail.
 *
 * A smoke check's output goes into the reports of whoever runs it (the
 * outside monitor after a release, or a person at a terminal), and those
 * should never hold a key. A direct `node:assert` call prints the values it
 * compares, a message built from a variable prints whatever that variable
 * held, and Node's own request errors can quote a URL or a header: any of
 * them can put an app key, a gateway token or a provider key in a report.
 *
 * Two parts keep that rule:
 *
 * - the compiler: every message the helpers in `smoke/support.ts` take is
 *   typed `Fixed`, so one built from a value does not compile (the last test
 *   below is checked by `pnpm run check`);
 * - this text scan, for what the types cannot see: a `node:assert` import, a
 *   `console` or `assert` call, a direct `fetch`, or an `Error` made from a
 *   value. It is a convenience that catches the usual slips, not a proof.
 *
 * Every smoke file is scanned, except those not converted to the helpers yet.
 */
import { describe, expect, it } from "vitest";
import { check, exchangeFrames, expectCode, fail, note, same } from "../smoke/support.ts";

const sources = (import.meta as ImportMeta & {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
}).glob<string>("../smoke/*.smoke.ts", { query: "?raw", import: "default", eager: true });

/**
 * Smoke files whose assertions do not go through `support.ts` yet. A new
 * smoke file is scanned from the start; one leaves this list once converted.
 */
const NOT_CONVERTED = new Set([
  "ai-gateways",
  "allowance",
  "console",
  "conversations",
  "deepgram-fal",
  "diagnostics",
  "elevenlabs",
  "handoffs",
  "health",
  "jobs",
  "large-bodies",
  "live-tokens",
  "management",
  "mcp",
  "media-apis",
  "passthrough",
  "pricing-units",
  "sign-in",
  "usage-read",
]);

/** What breaks the rule in one file's source, each with its line. */
function violations(source: string): string[] {
  const found: string[] = [];
  const line = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(/["']node:assert(?:\/strict)?["']/gu)) found.push(`line ${line(match.index)}: imports node:assert`);
  for (const match of source.matchAll(/\b(assert|console)\s*\.\s*\w+\s*\(/gu)) found.push(`line ${line(match.index)}: calls ${match[1]}`);
  for (const match of source.matchAll(/(?<![\w.])fetch\s*\(/gu)) found.push(`line ${line(match.index)}: calls fetch, not send`);
  // An Error whose message is anything but one plain quoted string.
  for (const match of source.matchAll(/\bnew\s+Error\s*\(\s*(?!(?:"[^"\\\n]*"|'[^'\\\n]*')\s*\))/gu)) {
    found.push(`line ${line(match.index)}: makes an Error from a value`);
  }
  return found;
}

const name = (path: string) => path.slice("../smoke/".length, -".smoke.ts".length);

describe("smoke checks print nothing a deployment answered", () => {
  it("lists only smoke files that exist", () => {
    const names = new Set(Object.keys(sources).map(name));
    expect([...NOT_CONVERTED].filter((file) => !names.has(file))).toEqual([]);
  });

  for (const [path, source] of Object.entries(sources)) {
    if (NOT_CONVERTED.has(name(path))) continue;
    it(`${name(path)}.smoke.ts asserts, prints and sends only through support.ts`, () => {
      expect(violations(source)).toEqual([]);
    });
  }

  it("catches each way the scan looks for", () => {
    expect(violations('import assert from "node:assert/strict";')).toHaveLength(1);
    expect(violations("assert.equal(a, b);")).toHaveLength(1);
    expect(violations("console.log(body);")).toHaveLength(1);
    expect(violations("console .log (body);")).toHaveLength(1);
    expect(violations("await fetch(url);")).toHaveLength(1);
    expect(violations("throw new Error(`got ${body}`);")).toHaveLength(1);
    expect(violations("throw new Error(String(body));")).toHaveLength(1);
    expect(violations('await send("/x", base);\nthrow new Error("fixed");\nreject(new Error(\'fixed\'));')).toEqual([]);
  });

  it("refuses, at compile time, a message built from a value", () => {
    const value = String(Date.now());
    // Each line below would print `value` if it compiled; `pnpm run check` fails when one does.
    // @ts-expect-error a template with a value in it
    expect(() => check(false, `got ${value}`)).toThrow();
    // @ts-expect-error a plain string variable
    expect(() => fail(value)).toThrow();
    // @ts-expect-error text joined with a value
    expect(() => same(1, 2, "got " + value)).toThrow();
    // @ts-expect-error a code read from a value
    expect(() => expectCode({}, value, "the call")).toThrow();
    // Never called: it would print. Only the compiler's refusal is checked.
    const neverCalled = () => {
      // @ts-expect-error a note built from a value
      note(`storage: ${value}`);
    };
    expect(typeof neverCalled).toBe("function");
    // Fixed text, or a choice of it, compiles.
    expect(() => check(true, "fixed")).not.toThrow();
    expect(() => same(1, 1, value === "" ? "one" : "other")).not.toThrow();
    expect(() => same(1, 2, "the counts differ")).toThrow("the counts differ: got 1, expected 2");
    expect(() => same("a", "b", "the names differ")).toThrow(/^the names differ$/u);
    expect(() => expectCode({ error: { code: "sk-Live1234" } }, "auth_required", "the call")).toThrow(
      "the call: expected auth_required, got an odd error code",
    );
  });
});

describe("the smoke WebSocket helper", () => {
  it("fails with fixed text for an address it can't use, never quoting it", async () => {
    await expect(exchangeFrames("/v2/relay/echo", "not a url agw_app_secret", [], 1)).rejects.toThrow(/^a WebSocket could not be opened$/u);
  });
});

