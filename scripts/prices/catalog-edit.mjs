// Surgical edits to src/usage/prices.json.
//
// The catalog is formatted by hand — short entries on one line, long ones a
// field per line, `5.0` rather than `5` — and a `JSON.stringify` round trip
// would rewrite every line of it. Instead the text is read with a small JSON
// reader that records where each value sits, and only the number literals
// being changed are replaced. The result is then parsed and compared with the
// original, so an edit that touched anything else is refused.

import { isDeepStrictEqual } from "node:util";
import { round6 } from "./price.mjs";

/** Reads one JSON value at `position`, recording the span of every value. */
function readValue(text, position) {
  const skip = (at) => {
    while (at < text.length && /\s/u.test(text[at])) at += 1;
    return at;
  };
  const start = skip(position);
  const char = text[start];

  if (char === "{" || char === "[") {
    const close = char === "{" ? "}" : "]";
    const node = { type: char === "{" ? "object" : "array", start, entries: [] };
    let at = skip(start + 1);
    if (text[at] === close) return { ...node, end: at + 1 };
    for (;;) {
      let key;
      if (node.type === "object") {
        const keyNode = readValue(text, at);
        if (keyNode.type !== "string") throw new Error(`prices.json: expected a key at ${at}`);
        key = keyNode.value;
        at = skip(keyNode.end);
        if (text[at] !== ":") throw new Error(`prices.json: expected ":" at ${at}`);
        at += 1;
      }
      const value = readValue(text, at);
      node.entries.push({ key, value });
      at = skip(value.end);
      if (text[at] === ",") {
        at += 1;
        continue;
      }
      if (text[at] !== close) throw new Error(`prices.json: expected "," or "${close}" at ${at}`);
      return { ...node, end: at + 1 };
    }
  }

  if (char === '"') {
    let at = start + 1;
    while (text[at] !== '"') {
      if (at >= text.length) throw new Error("prices.json: a string never closes");
      at += text[at] === "\\" ? 2 : 1;
    }
    return { type: "string", start, end: at + 1, value: JSON.parse(text.slice(start, at + 1)) };
  }

  const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(text.slice(start));
  if (!literal) throw new Error(`prices.json: unexpected "${char}" at ${start}`);
  const end = start + literal[0].length;
  return { type: /^[-\d]/u.test(literal[0]) ? "number" : "literal", start, end };
}

function member(node, key, where) {
  const matches = node.entries.filter((entry) => entry.key === key);
  if (matches.length !== 1) {
    throw new Error(`prices.json: ${where} is ${matches.length === 0 ? "missing" : "duplicated"}`);
  }
  return matches[0].value;
}

/**
 * The literal a new price is written as: the shortest decimal, after rounding
 * away float noise, and with `.0` on a whole number as the rest of the
 * catalog writes it.
 */
export function formatPrice(value) {
  const text = String(round6(value));
  return /^\d+$/u.test(text) ? `${text}.0` : text;
}

/**
 * Applies `[{ provider, model, field, to }]` to the catalog text. Only a field
 * the entry already has can be changed; nothing is ever added or removed.
 */
export function applyEdits(text, edits) {
  if (edits.length === 0) return text;
  const root = readValue(text, 0);
  if (root.type !== "object") throw new Error("prices.json: the root is not an object");

  const replacements = edits.map((edit) => {
    const where = `${edit.provider}/${edit.model}`;
    const provider = member(root, edit.provider, edit.provider);
    const model = member(provider, edit.model, where);
    const value = member(model, edit.field, `${where} ${edit.field}`);
    if (value.type !== "number") throw new Error(`prices.json: ${where} ${edit.field} is not a number`);
    return { start: value.start, end: value.end, literal: formatPrice(edit.to) };
  });
  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const [index, replacement] of replacements.entries()) {
    if (replacements[index - 1]?.start === replacement.start) {
      throw new Error("prices.json: two edits to the same value");
    }
    result = result.slice(0, replacement.start) + replacement.literal + result.slice(replacement.end);
  }

  const expected = JSON.parse(text);
  for (const edit of edits) expected[edit.provider][edit.model][edit.field] = round6(edit.to);
  if (!isDeepStrictEqual(JSON.parse(result), expected)) {
    throw new Error("prices.json: the edited file differs from the original in more than the intended values");
  }
  return result;
}
