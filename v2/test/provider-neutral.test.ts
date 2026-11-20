/**
 * Serving never branches on a provider's id. How a request is read, parsed,
 * metered and priced is declared on the operation or its reading rules
 * (`src/providers/operation.ts`), so a custom provider's path that copies a
 * built-in definition behaves as that provider's own operation does
 * (`src/providers/custom.ts`). A provider id written in serving code is
 * where that went wrong before: a rule found by name skips every connection
 * of another type.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { CUSTOM_TYPE } from "../src/providers/custom.ts";

const sources = (import.meta as ImportMeta & {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
}).glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** The code that serves a request: reading, parsing, metering, pricing and charging it. */
const SERVING = [/^\.\.\/src\/proxy\//u, /^\.\.\/src\/usage\//u, /^\.\.\/src\/pricing\//u, /^\.\.\/src\/ledger\//u, /^\.\.\/src\/providers\/presets\.ts$/u];

/**
 * Files allowed to name a provider id, each with why. Empty: none needs to.
 * A new entry needs a reason a reviewer would accept.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

/** Comments are prose; only code is judged. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

describe("serving is provider-neutral", () => {
  it("names no provider id, and does not test for a custom provider, in serving code", () => {
    const ids = [...Object.keys(BUILT_IN_PROVIDERS), CUSTOM_TYPE];
    const literal = new RegExp(`["'\`](${ids.join("|")})["'\`]`, "u");
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (!SERVING.some((pattern) => pattern.test(file)) || Object.hasOwn(EXEMPT, file)) continue;
      const body = code(text);
      const found = literal.exec(body);
      if (found !== null) offenders.push(`${file}: ${found[0]}`);
      if (/\bCUSTOM_TYPE\b/u.test(body)) offenders.push(`${file}: CUSTOM_TYPE`);
    }
    expect(Object.keys(sources).some((file) => file === "../src/proxy/meter.ts")).toBe(true);
    expect(offenders).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) expect(reason.trim().length, file).toBeGreaterThan(20);
  });
});
