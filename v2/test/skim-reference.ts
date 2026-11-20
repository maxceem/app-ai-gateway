/**
 * What the skimmer (`src/usage/skim.ts`) keeps from a whole JSON text, worked
 * out apart from it: the text is parsed into values with their spans, then
 * the declared paths are walked in document order by the documented rules.
 * Sizes are counted on the text as written, as the skimmer counts them, never
 * on the value written out again.
 */
import { MAX_LIST_ELEMENTS, SKIM_VALUE_CAP, type PathTree } from "../src/usage/skim.ts";

type Node =
  | { readonly kind: "object"; readonly start: number; readonly end: number; readonly members: readonly (readonly [string, Node])[] }
  | { readonly kind: "array"; readonly start: number; readonly end: number; readonly items: readonly Node[] }
  | { readonly kind: "scalar"; readonly start: number; readonly end: number };

/** Parses a valid JSON text into values with their spans. */
function parse(text: string): Node {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\r\n".includes(text[at]!)) at += 1;
  };
  const string = (): void => {
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
  };
  const value = (): Node => {
    space();
    const start = at;
    const first = text[at];
    if (first === "{") {
      at += 1;
      const members: (readonly [string, Node])[] = [];
      space();
      if (text[at] === "}") {
        at += 1;
        return { kind: "object", start, end: at, members };
      }
      for (;;) {
        space();
        const keyStart = at;
        string();
        const key = JSON.parse(text.slice(keyStart, at)) as string;
        space();
        at += 1; // :
        members.push([key, value()]);
        space();
        if (text[at++] === "}") return { kind: "object", start, end: at, members };
      }
    }
    if (first === "[") {
      at += 1;
      const items: Node[] = [];
      space();
      if (text[at] === "]") {
        at += 1;
        return { kind: "array", start, end: at, items };
      }
      for (;;) {
        items.push(value());
        space();
        if (text[at++] === "]") return { kind: "array", start, end: at, items };
      }
    }
    if (first === '"') string();
    else while (at < text.length && !" \t\r\n,]}".includes(text[at]!)) at += 1;
    return { kind: "scalar", start, end: at };
  };
  const root = value();
  space();
  return root;
}

interface List {
  readonly elements: unknown[];
  readonly holder: Record<string, unknown>;
  readonly key: string;
  bytes: number;
  count: number;
  over: boolean;
}

/**
 * The documents the skimmer keeps from `text` with `tree`, and whether it set
 * `overflow`. A root object is one document; with `arrayDocuments`, so is
 * each object element of a root array.
 */
export function pickText(text: string, tree: PathTree, arrayDocuments = false): { documents: Record<string, unknown>[]; overflow: boolean } {
  let overflow = false;
  const lists: List[] = [];
  const over = (list: List) => {
    list.over = true;
    list.elements.length = 0;
    if (list.holder[list.key] === list.elements) delete list.holder[list.key];
    overflow = true;
  };
  const object = (node: Node & { kind: "object" }, declaredTree: PathTree): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, member] of node.members) {
      if (!Object.hasOwn(declaredTree, key)) continue;
      const declared = declaredTree[key]!;
      if (declared === true || declared === "max") {
        const length = member.end - member.start;
        if (length > SKIM_VALUE_CAP) {
          delete out[key];
          overflow = true;
          continue;
        }
        out[key] = JSON.parse(text.slice(member.start, member.end)) as unknown;
        for (const list of lists) {
          if (list.over) continue;
          list.bytes += length;
          if (list.bytes > SKIM_VALUE_CAP) over(list);
        }
      } else if (member.kind === "object") {
        out[key] = object(member, declared);
      } else if (member.kind === "array" && Object.values(declared).length > 0 && Object.values(declared).every((one) => one === "max")) {
        // The largest number of each member across the elements, never the elements.
        const aggregate: Record<string, unknown> = {};
        out[key] = aggregate;
        for (const item of member.items) {
          if (item.kind !== "object") continue;
          for (const [name, value] of Object.entries(object(item, declared))) {
            if (typeof value === "number" && Number.isFinite(value) && !(typeof aggregate[name] === "number" && aggregate[name] >= value)) aggregate[name] = value;
          }
        }
      } else if (member.kind === "array") {
        const list: List = { elements: [], holder: out, key, bytes: 0, count: 0, over: false };
        out[key] = list.elements;
        lists.push(list);
        for (const item of member.items) {
          if (list.over) break;
          if (item.kind !== "object") continue;
          const kept = object(item, declared);
          if (list.over || Object.keys(kept).length === 0) continue;
          list.elements.push(kept);
          if (++list.count > MAX_LIST_ELEMENTS) over(list);
        }
        lists.pop();
      } else {
        delete out[key];
      }
    }
    return out;
  };
  const root = parse(text);
  const documents: Record<string, unknown>[] = [];
  if (root.kind === "object") documents.push(object(root, tree));
  else if (root.kind === "array" && arrayDocuments) for (const item of root.items) if (item.kind === "object") documents.push(object(item, tree));
  return { documents, overflow };
}
