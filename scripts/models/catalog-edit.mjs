// Surgical edits to src/usage/models.json.
//
// The catalog is formatted by hand — an entry on one line when it fits in 100
// columns, a field per line when it does not, `5.0` rather than `5` — and a
// `JSON.stringify` round trip would rewrite every line of it. Instead the text
// is read with a small JSON reader that records where each value sits, and
// only the literals being changed are replaced. The one field that may be
// added, `retirement_date`, goes after an entry's last field, and an entry
// that no longer fits on its line is spread over several. The result is then
// parsed and compared with the original, so an edit that touched anything
// else is refused.

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
      let keyStart;
      if (node.type === "object") {
        const keyNode = readValue(text, at);
        if (keyNode.type !== "string") throw new Error(`models.json: expected a key at ${at}`);
        key = keyNode.value;
        keyStart = keyNode.start;
        at = skip(keyNode.end);
        if (text[at] !== ":") throw new Error(`models.json: expected ":" at ${at}`);
        at += 1;
      }
      const value = readValue(text, at);
      node.entries.push({ key, keyStart, value });
      at = skip(value.end);
      if (text[at] === ",") {
        at += 1;
        continue;
      }
      if (text[at] !== close) throw new Error(`models.json: expected "," or "${close}" at ${at}`);
      return { ...node, end: at + 1 };
    }
  }

  if (char === '"') {
    let at = start + 1;
    while (text[at] !== '"') {
      if (at >= text.length) throw new Error("models.json: a string never closes");
      at += text[at] === "\\" ? 2 : 1;
    }
    return { type: "string", start, end: at + 1, value: JSON.parse(text.slice(start, at + 1)) };
  }

  const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(text.slice(start));
  if (!literal) throw new Error(`models.json: unexpected "${char}" at ${start}`);
  const end = start + literal[0].length;
  return { type: /^[-\d]/u.test(literal[0]) ? "number" : "literal", start, end };
}

/** Fields an edit may add to an entry; every other edit changes a value in place. */
const ADDABLE = new Set(["retirement_date"]);
const WIDTH = 100;

function member(node, key, where) {
  const matches = node.entries.filter((entry) => entry.key === key);
  if (matches.length > 1) throw new Error(`models.json: ${where} is duplicated`);
  return matches[0]?.value;
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

function literal(value) {
  return typeof value === "number" ? formatPrice(value) : JSON.stringify(value);
}

function lineStart(text, position) {
  return text.lastIndexOf("\n", position - 1) + 1;
}

function lineEnd(text, position) {
  const end = text.indexOf("\n", position);
  return end === -1 ? text.length : end;
}

/** One model's object with its edits applied, formatted as the file formats it. */
function rewriteEntry(text, node, edits, where) {
  const original = text.slice(node.start, node.end);
  const replaced = new Map();
  const added = [];
  for (const edit of edits) {
    const value = member(node, edit.field, `${where} ${edit.field}`);
    if (value === undefined) {
      if (!ADDABLE.has(edit.field)) throw new Error(`models.json: ${where} ${edit.field} is missing`);
      added.push([edit.field, literal(edit.to)]);
      continue;
    }
    const expected = typeof edit.to === "number" ? "number" : "string";
    if (value.type !== expected) throw new Error(`models.json: ${where} ${edit.field} is not a ${expected}`);
    if (replaced.has(value)) throw new Error(`models.json: two edits to ${where} ${edit.field}`);
    replaced.set(value, literal(edit.to));
  }

  // Changing values keeps the entry's layout exactly.
  let result = original;
  for (const [value, written] of [...replaced].sort((a, b) => b[0].start - a[0].start)) {
    result = result.slice(0, value.start - node.start) + written + result.slice(value.end - node.start);
  }
  if (added.length === 0) return result;

  const members = node.entries.map((entry) => [
    JSON.stringify(entry.key),
    replaced.get(entry.value) ?? text.slice(entry.value.start, entry.value.end),
  ]);
  for (const [field, value] of added) members.push([JSON.stringify(field), value]);

  if (!original.includes("\n")) {
    const prefix = text.slice(lineStart(text, node.start), node.start);
    const suffix = text.slice(node.end, lineEnd(text, node.end));
    const inline = `{ ${members.map(([key, value]) => `${key}: ${value}`).join(", ")} }`;
    if (prefix.length + inline.length + suffix.length <= WIDTH) return inline;
    const indent = /^\s*/u.exec(prefix)[0];
    return `{\n${members.map(([key, value]) => `${indent}  ${key}: ${value}`).join(",\n")}\n${indent}}`;
  }

  // A multi-line entry gains lines after its last field, at that field's indent.
  const last = node.entries.at(-1);
  const indent = /^\s*/u.exec(text.slice(lineStart(text, last.keyStart), last.keyStart))[0];
  const cut = last.value.end - node.start;
  const extra = added.map(([field, value]) => `,\n${indent}${JSON.stringify(field)}: ${value}`).join("");
  return result.slice(0, cut) + extra + result.slice(cut);
}

/**
 * Applies `[{ provider, model, field, to }]` to the catalog text. A price
 * field must already exist; `retirement_date` may be added. Nothing is ever
 * removed.
 */
export function applyEdits(text, edits) {
  if (edits.length === 0) return text;
  const root = readValue(text, 0);
  if (root.type !== "object") throw new Error("models.json: the root is not an object");

  const byEntry = new Map();
  for (const edit of edits) {
    const where = `${edit.provider}/${edit.model}`;
    const provider = member(root, edit.provider, edit.provider);
    const model = provider && member(provider, edit.model, where);
    if (!model || model.type !== "object") throw new Error(`models.json: ${where} is missing`);
    if (!byEntry.has(model)) byEntry.set(model, { where, edits: [] });
    byEntry.get(model).edits.push(edit);
  }

  let result = text;
  for (const [node, { where, edits: entryEdits }] of [...byEntry].sort((a, b) => b[0].start - a[0].start)) {
    result = result.slice(0, node.start) + rewriteEntry(text, node, entryEdits, where) + result.slice(node.end);
  }

  const expected = JSON.parse(text);
  for (const edit of edits) {
    expected[edit.provider][edit.model][edit.field] = typeof edit.to === "number" ? round6(edit.to) : edit.to;
  }
  if (!isDeepStrictEqual(JSON.parse(result), expected)) {
    throw new Error("models.json: the edited file differs from the original in more than the intended values");
  }
  return result;
}

/** Explicitly approved additions. Existing entries and their formatting stay intact. */
export function addModels(text, additions) {
  const expected = JSON.parse(text);
  let result = text;
  for (const { provider, model, price } of additions) {
    if (!Object.hasOwn(expected, provider)) throw new Error(`models.json: unknown provider ${provider}`);
    if (Object.hasOwn(expected[provider], model)) throw new Error(`models.json: ${provider}/${model} already exists`);
    const root = readValue(result, 0);
    const node = member(root, provider, provider);
    const fields = Object.entries(price).map(([key, value]) => `${JSON.stringify(key)}: ${key === "long_context_threshold" ? JSON.stringify(value) : literal(value)}`);
    const prefix = `    ${JSON.stringify(model)}: `;
    const inline = `${prefix}{ ${fields.join(", ")} }`;
    const entry = inline.length + 1 <= WIDTH ? inline : `${prefix}{\n${fields.map((field) => `      ${field}`).join(",\n")}\n    }`;
    // Insert first: the provider's closing brace and all existing entries remain byte-for-byte.
    const at = node.start + 1;
    result = result.slice(0, at) + `\n${entry}${node.entries.length > 0 ? "," : ""}` + result.slice(at);
    expected[provider][model] = price;
  }
  if (!isDeepStrictEqual(JSON.parse(result), expected)) throw new Error("models.json: an addition changed other values");
  return result;
}
