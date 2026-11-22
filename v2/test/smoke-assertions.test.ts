/**
 * The smoke checks print nothing a deployment answered when they fail.
 *
 * The repository is public and its CI logs can be read by anyone, so a smoke
 * check's failure message is published. A direct `node:assert` call prints
 * the values it compares, and a message built from a variable prints whatever
 * that variable held: either can put an app key, a gateway token or a
 * provider key in the log. So the guarded files assert only through the
 * helpers in `smoke/support.ts`, each with a plain string for its message;
 * the helpers add a status and a listed error code at most.
 */
import { describe, expect, it } from "vitest";

const sources = (import.meta as ImportMeta & {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
}).glob<string>("../smoke/*.smoke.ts", { query: "?raw", import: "default", eager: true });

/** The checks held to this rule. A smoke file joins the list once its assertions go through `support.ts`. */
const GUARDED = [
  "app-attest",
  "cli",
  "custom-providers",
  "first-call",
  "llm-styles",
  "presets",
  "provider-errors",
  "signed-in",
];

/** The helpers from `smoke/support.ts` whose last argument is the message. */
const HELPERS = ["check", "same", "fail", "expectStatus", "expectResponse", "expectCode", "expectCli", "assertHolds"];

/** Skips a quoted string or a template starting at `index`; returns the index after it. */
function skipString(text: string, index: number): number {
  const quote = text[index]!;
  let at = index + 1;
  while (at < text.length && text[at] !== quote) {
    if (text[at] === "\\") at += 1;
    else if (quote === "`" && text[at] === "$" && text[at + 1] === "{") {
      at = closing(text, at + 2, "{", "}") - 1;
    }
    at += 1;
  }
  return at + 1;
}

/** The index just after the bracket that closes one opened before `index`. */
function closing(text: string, index: number, open: string, close: string): number {
  let depth = 0;
  let at = index;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") {
      at = skipString(text, at);
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      if (depth === 0) return at + 1;
      depth -= 1;
    }
    at += 1;
  }
  throw new Error("unbalanced brackets");
}

/** The top-level arguments of a call whose `(` is just before `index`. */
function argumentsAt(text: string, index: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = index;
  let at = index;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") {
      at = skipString(text, at);
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) {
        args.push(text.slice(start, at));
        return args.map((arg) => arg.trim()).filter((arg) => arg !== "");
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(text.slice(start, at));
      start = at + 1;
    }
    at += 1;
  }
  throw new Error("unbalanced call");
}

/** A string written out whole: quoted, or a template with nothing filled in. */
function plainString(arg: string): boolean {
  return /^"(?:[^"\\\n]|\\.)*"$/u.test(arg) || /^'(?:[^'\\\n]|\\.)*'$/u.test(arg) || /^`[^`$\\]*`$/u.test(arg);
}

/** What breaks the rule in one file's source, each with its line. */
function violations(source: string): string[] {
  const found: string[] = [];
  const line = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(/["']node:assert(?:\/strict)?["']/gu)) found.push(`line ${line(match.index)}: imports node:assert`);
  for (const match of source.matchAll(/\bassert\.\w+\(/gu)) found.push(`line ${line(match.index)}: calls ${match[0].slice(0, -1)}`);
  for (const match of source.matchAll(new RegExp(`(?<![\\w.])(${HELPERS.join("|")})\\(`, "gu"))) {
    const args = argumentsAt(source, match.index + match[0].length);
    const message = args.at(-1) ?? "";
    if (!plainString(message)) found.push(`line ${line(match.index)}: ${match[1]} has a message that is not a plain string`);
  }
  return found;
}

describe("smoke checks print nothing a deployment answered", () => {
  for (const name of GUARDED) {
    it(`${name}.smoke.ts asserts only through support.ts, with plain-string messages`, () => {
      const source = sources[`../smoke/${name}.smoke.ts`];
      expect(source, `no smoke/${name}.smoke.ts`).toBeTypeOf("string");
      expect(violations(source!)).toEqual([]);
    });
  }

  it("catches each way a value could reach the log", () => {
    expect(violations('import assert from "node:assert/strict";')).toHaveLength(1);
    expect(violations("assert.equal(a, b);")).toHaveLength(1);
    expect(violations("check(ok, `got ${body}`);")).toHaveLength(1);
    expect(violations("same(a, b, message);")).toHaveLength(1);
    expect(violations("fail(String(body));")).toHaveLength(1);
    expect(violations('check(ok);')).toHaveLength(1);
    expect(violations('check(f(a, "x"), "fixed");\nsame(a, { b: [1, 2] }, `fixed`);\nawait expectResponse(r, 200, "the call");')).toEqual([]);
  });
});
