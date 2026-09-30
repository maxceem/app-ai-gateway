// https://platform.moonshot.ai/docs/pricing/chat.md
//
// Each table is a JSX `<DocTable columns={[…]} rows={[…]} />`. It is never
// evaluated: the column titles must be one of the layouts below exactly, and
// every row is read with a strict pattern in which a price is
// `<>{"$"}3.00</>` and every other cell a plain string.

import { ParseError, decimal, put } from "../price.mjs";

// Column title → catalog field; null for a column that is read but not priced.
const LAYOUTS = [
  {
    Model: "model",
    Unit: "unit",
    "Cache Write Price (TTL 5min)": "cache_write",
    "Cache Write Price (TTL 1h)": null,
    "Cached Input Price": "cached_input",
    "Input Price": "input",
    "Output Price": "output",
    "Context Window": null,
  },
  {
    Model: "model",
    Unit: "unit",
    "Input Price (Cache Hit)": "cached_input",
    "Input Price (Cache Miss)": "input",
    "Output Price": "output",
    "Context Window": null,
  },
];

const TABLE = /<DocTable\n {2}columns=\{\[\n([\s\S]*?)\n\]\}\n {2}rows=\{\[\n([\s\S]*?)\n\]\}\n\/>/gu;
const COLUMN = /^\{ title: "([^"]*)", width: "\d+%" \},$/u;
const ROW = /^\[(.*)\],$/u;
const CELL = /"([^"\\]*)"|<>\{"\$"\}(\d+(?:\.\d+)?)<\/>/uy;

function readRow(line, where) {
  const match = ROW.exec(line);
  if (!match) throw new ParseError(`${where}: unexpected row "${line.slice(0, 80)}"`);
  const body = match[1];
  const cells = [];
  let position = 0;
  while (position < body.length) {
    CELL.lastIndex = position;
    const cell = CELL.exec(body);
    if (!cell) throw new ParseError(`${where}: unexpected cell at "${body.slice(position, position + 40)}"`);
    cells.push(cell[1] !== undefined ? { text: cell[1] } : { price: cell[2] });
    position = CELL.lastIndex;
    if (position === body.length) break;
    if (body.slice(position, position + 2) !== ", ") {
      throw new ParseError(`${where}: unexpected separator at "${body.slice(position, position + 40)}"`);
    }
    position += 2;
  }
  return cells;
}

export function parseMoonshot(text, { wanted }) {
  const prices = new Map();
  const tables = [...text.matchAll(TABLE)];
  // Every use of the component must be readable, so a table that changed
  // shape fails the page rather than dropping out of it unseen.
  const uses = text.split("<DocTable").length - 1;
  if (tables.length === 0 || tables.length !== uses) {
    throw new ParseError(`found ${tables.length} readable tables of ${uses}`);
  }

  for (const table of tables) {
    const titles = table[1].split("\n").map((line) => {
      const column = COLUMN.exec(line);
      if (!column) throw new ParseError(`unexpected column "${line}"`);
      return column[1];
    });
    const layout = LAYOUTS.find(
      (candidate) =>
        Object.keys(candidate).length === titles.length &&
        titles.every((title) => Object.hasOwn(candidate, title)),
    );
    if (!layout) throw new ParseError(`unknown table columns "${titles.join(" | ")}"`);
    const fields = titles.map((title) => layout[title]);

    for (const line of table[2].split("\n")) {
      const cells = readRow(line, "rows");
      if (cells.length !== fields.length) {
        throw new ParseError(`a row has ${cells.length} cells, the table has ${fields.length} columns`);
      }
      const id = cells[fields.indexOf("model")].text;
      if (id === undefined || !/^[a-z0-9][a-z0-9.-]*$/u.test(id)) {
        throw new ParseError(`unexpected model cell in "${line.slice(0, 80)}"`);
      }
      if (!wanted.has(id)) {
        put(prices, id, null);
        continue;
      }
      if (cells[fields.indexOf("unit")].text !== "1M tokens") {
        throw new ParseError(`${id}: the unit is not "1M tokens"`);
      }
      const price = {};
      for (const [index, field] of fields.entries()) {
        if (field === null || field === "model" || field === "unit") continue;
        const cell = cells[index];
        if (cell.price === undefined) throw new ParseError(`${id}: ${titles[index]} is not a price`);
        price[field] = decimal(cell.price, id);
      }
      put(prices, id, {
        input: price.input,
        output: price.output,
        ...(price.cached_input !== undefined && { cached_input: price.cached_input }),
        ...(price.cache_write !== undefined && { cache_write: price.cache_write }),
      });
    }
  }
  return prices;
}
