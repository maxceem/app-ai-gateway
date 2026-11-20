/**
 * The skimmer's contract (`src/usage/skim.ts`): for any JSON document, fed in
 * pieces split anywhere, it keeps exactly what the reference
 * (`./skim-reference.ts`) works out from the whole text.
 */
import { describe, expect, it } from "vitest";
import { MAX_LIST_ELEMENTS, Skimmer, SKIM_VALUE_CAP, type PathTree } from "../src/usage/skim.ts";
import { pickText } from "./skim-reference.ts";

const TREE: PathTree = {
  usage: true,
  model: true,
  type: true,
  response: { usage: true, model: true },
  message: { usage: true },
};

/** A small seeded random source, so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["usage", "model", "type", "response", "message", "data", "x", "us\\u0061ge", "usage ", "Usage", "a\\\"b", "\\\\"];
/** JSON string texts, quotes included: escapes of every kind, and text that looks like JSON. */
const STRINGS = [
  ...["", "plain", 'with "quote"', "back\\slash", "brace } and ] and {", "line\nbreak", "ünïcødé ✓", "\\", '"', '\\"usage\\":1}', "ends with \\"].map(
    (raw) => JSON.stringify(raw),
  ),
  '"\\u00e9t\\u00e9"',
  '"\\/\\b\\f\\t"',
];
const SPACES = ["", "", "", " ", "\n", " \t\r\n "];

/** A random JSON text, written by hand so keys can repeat and space can fall anywhere JSON allows. */
function document(next: () => number, depth = 0): string {
  const pickOne = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const space = () => pickOne(SPACES);
  const roll = next();
  if (depth > 3 || roll < 0.3) {
    const scalar = next();
    if (scalar < 0.3) return pickOne(STRINGS);
    if (scalar < 0.6) return pickOne(["0", "-1", "42", "3.25", "1e3", "-2.5E-2", "123456789012"]);
    return pickOne(["true", "false", "null"]);
  }
  if (roll < 0.5) {
    const items = Array.from({ length: Math.floor(next() * 4) }, () => space() + document(next, depth + 1) + space());
    return `[${items.join(",")}]`;
  }
  const members = Array.from({ length: Math.floor(next() * 6) }, () => {
    const key = next() < 0.7 ? pickOne(KEYS.slice(0, 5)) : pickOne(KEYS);
    return `${space()}"${key}"${space()}:${space()}${document(next, depth + 1)}${space()}`;
  });
  return `{${members.join(",")}}`;
}

function skim(text: string, pieces: readonly string[], options: { arrayDocuments?: boolean } = {}) {
  const documents: Record<string, unknown>[] = [];
  const skimmer = new Skimmer(TREE, { ...options, onDocument: (value) => documents.push(value) });
  for (const piece of pieces) skimmer.push(piece);
  skimmer.end();
  return { documents, complete: skimmer.complete, failed: skimmer.failed, text };
}

/** What the contract says the skimmer keeps from `text`. */
function expected(text: string, arrayDocuments: boolean): Record<string, unknown>[] {
  return pickText(text, TREE, arrayDocuments).documents;
}

/** `text` split at every point (at most 300 of them, spread evenly), and into single characters. */
function splits(text: string): string[][] {
  const out: string[][] = [[text], Array.from(text)];
  const step = Math.max(1, Math.floor(text.length / 300));
  for (let at = 1; at < text.length; at += step) out.push([text.slice(0, at), text.slice(at)]);
  return out;
}

/** A value as text with its keys sorted, so two results compare as strings, fast. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

describe("the skimmer keeps exactly what JSON.parse would, at the declared paths", () => {
  it("matches JSON.parse on random documents, split at every point", () => {
    const next = random(20261120);
    for (let round = 0; round < 120; round += 1) {
      const root = next() < 0.8 ? document(next) : `[${document(next)},${document(next)}]`;
      const text = `${next() < 0.3 ? " \n" : ""}${root}${next() < 0.3 ? "\n " : ""}`;
      const arrayDocuments = next() < 0.5;
      const want = canonical(expected(text, arrayDocuments));
      for (const pieces of splits(text)) {
        const got = skim(text, pieces, { arrayDocuments });
        const where = `${text} split ${JSON.stringify(pieces.map((piece) => piece.length).slice(0, 3))}`;
        if (got.failed || !got.complete || canonical(got.documents) !== want) {
          expect({ failed: got.failed, complete: got.complete, documents: canonical(got.documents) }, where).toEqual({
            failed: false,
            complete: true,
            documents: want,
          });
        }
      }
    }
  });

  it("matches JSON.parse when split into many random pieces", () => {
    const next = random(7);
    for (let round = 0; round < 150; round += 1) {
      const text = document(next);
      const want = canonical(expected(text, false));
      for (let trial = 0; trial < 5; trial += 1) {
        const pieces: string[] = [];
        let at = 0;
        while (at < text.length) {
          const size = 1 + Math.floor(next() * 7);
          pieces.push(text.slice(at, at + size));
          at += size;
        }
        expect(canonical(skim(text, pieces).documents), text).toBe(want);
      }
    }
  });

  it("keeps a key's last value, as JSON.parse does", () => {
    const text = '{"usage":1,"response":{"usage":2},"usage":{"a":3},"response":"gone","response":{"model":"m"}}';
    expect(skim(text, [text]).documents).toEqual([{ usage: { a: 3 }, response: { model: "m" } }]);
    expect(skim(text, [text]).documents).toEqual(expected(text, false));
  });

  it("keeps the declared members of each object in an array, and leaves its other elements out", () => {
    const text = '{"response":[{"model":"a","x":[1,{"model":"no"}]},7,"s",[{"model":"nested"}],{"usage":{"n":2}},{}],"message":[]}';
    // `{}` declares nothing, so it is left out like the number, the string and the nested list.
    const want = [{ response: [{ model: "a" }, { usage: { n: 2 } }], message: [] }];
    for (const pieces of splits(text)) expect(skim(text, pieces).documents).toEqual(want);
    expect(expected(text, false)).toEqual(want);
  });

  const UTTERANCES: PathTree = { results: { utterances: { end: true } } };
  const skimWith = (tree: PathTree, text: string) => {
    const documents: Record<string, unknown>[] = [];
    const skimmer = new Skimmer(tree, { onDocument: (value) => documents.push(value) });
    skimmer.push(text);
    skimmer.end();
    return { documents, overflow: skimmer.overflow, complete: skimmer.complete };
  };

  it("keeps nothing for a long list of elements that declare nothing, and does not overflow", () => {
    const text = `{"results":{"utterances":[${Array.from({ length: 100_000 }, () => '{"start":1,"words":[]}').join(",")}]}}`;
    expect(skimWith(UTTERANCES, text)).toEqual({ documents: [{ results: { utterances: [] } }], overflow: false, complete: true });
    expect(pickText(text, UTTERANCES)).toEqual({ documents: [{ results: { utterances: [] } }], overflow: false });
  });

  it("leaves out a list past its element cap or its text cap, and says so", () => {
    const many = `{"results":{"utterances":[${Array.from({ length: MAX_LIST_ELEMENTS + 1 }, () => '{"end":1}').join(",")}]},"model":"m"}`;
    const read = skimWith({ ...UTTERANCES, model: true }, many);
    expect(read).toEqual({ documents: [{ results: {}, model: "m" }], overflow: true, complete: true });
    expect(pickText(many, { ...UTTERANCES, model: true })).toEqual({ documents: read.documents, overflow: true });
    // Exactly at the cap is kept.
    const atCap = `{"results":{"utterances":[${Array.from({ length: MAX_LIST_ELEMENTS }, () => '{"end":1}').join(",")}]}}`;
    expect(skimWith(UTTERANCES, atCap).overflow).toBe(false);
    // Fewer elements whose kept text passes the cap together.
    const long = `"${"a".repeat(1000)}"`;
    const bytes = `{"results":{"utterances":[${Array.from({ length: Math.ceil(SKIM_VALUE_CAP / long.length) + 1 }, () => `{"end":${long}}`).join(",")}]}}`;
    expect(skimWith(UTTERANCES, bytes)).toMatchObject({ documents: [{ results: {} }], overflow: true });
    expect(pickText(bytes, UTTERANCES)).toMatchObject({ documents: [{ results: {} }], overflow: true });
  });

  it("caps a leaf by its text as written, as the reference does", () => {
    // `[0]` padded past the cap: small written again, too large as sent.
    const text = `{"usage":[0${" ".repeat(SKIM_VALUE_CAP)}],"model":"m"}`;
    for (const pieces of [[text], [text.slice(0, 9), text.slice(9)]]) {
      expect(skimWith(TREE, pieces.join(""))).toEqual({ documents: [{ model: "m" }], overflow: true, complete: true });
    }
    expect(pickText(text, TREE)).toEqual({ documents: [{ model: "m" }], overflow: true });
    // One character under the cap is kept.
    const under = `{"usage":[0${" ".repeat(SKIM_VALUE_CAP - 4)}]}`;
    expect(skimWith(TREE, under)).toMatchObject({ documents: [{ usage: [0] }], overflow: false });
    expect(pickText(under, TREE)).toEqual({ documents: [{ usage: [0] }], overflow: false });
  });

  it("decodes escaped keys, as JSON.parse does", () => {
    const text = '{"us\\u0061ge":{"n":1},"x":"\\"usage\\": 9"}';
    expect(skim(text, Array.from(text)).documents).toEqual([{ usage: { n: 1 } }]);
  });

  it("counts a number or literal only once a delimiter shows it is whole", () => {
    const cut = new Skimmer(TREE);
    cut.push('{"usage":42');
    expect(cut.openDocument).toEqual({});
    cut.push("e2}");
    expect(cut.complete).toBe(true);
    for (const text of ['{"usage":42e', '{"usage":nul', '{"usage":"abc', '{"usage":{"n":1']) {
      const skimmer = new Skimmer(TREE);
      skimmer.push(text);
      expect(skimmer.openDocument, text).toEqual({});
      expect(skimmer.complete).toBe(false);
    }
  });

  it("leaves out a value larger than the cap, and says so", () => {
    const big = `"${"a".repeat(SKIM_VALUE_CAP)}"`;
    const skimmer = new Skimmer(TREE);
    const documents: unknown[] = [];
    const text = `{"model":"m","usage":${big}}`;
    const withCallback = new Skimmer(TREE, { onDocument: (value) => documents.push(value) });
    withCallback.push(text);
    expect(documents).toEqual([{ model: "m" }]);
    expect(withCallback.overflow).toBe(true);
    skimmer.push(text.slice(0, 10));
    expect(skimmer.overflow).toBe(false);
  });

  it("skips a large number array and a large base64 string without keeping them", () => {
    const numbers = Array.from({ length: 50_000 }, (_, index) => (index % 7) * 0.125).join(",");
    const text = `{"data":[{"embedding":[${numbers}]}],"blob":"${"QUJD".repeat(50_000)}","usage":{"prompt_tokens":5}}`;
    expect(skim(text, [text.slice(0, 123_456), text.slice(123_456)]).documents).toEqual([{ usage: { prompt_tokens: 5 } }]);
  });

  it("closes a skipped container only with its own kind of bracket (Sol round 2, S6)", () => {
    for (const text of ['{"x":[1,2}}', '{"x":{"a":1]}', '{"x":[{"a":[1}]}']) {
      const skimmer = new Skimmer(TREE);
      skimmer.push(text);
      skimmer.end();
      expect(skimmer.failed, text).toBe(true);
    }
  });

  it("stops reading at text that is not JSON, keeping what was whole before it", () => {
    const skimmer = new Skimmer(TREE);
    skimmer.push('{"model":"m","usage" 5}');
    expect(skimmer.failed).toBe(true);
    expect(skimmer.openDocument).toEqual({ model: "m" });
  });
});
