// https://developers.openai.com/api/docs/deprecations.md
//
// Two tables whose first column is "Shutdown date": upcoming shutdowns, then
// past ones, each date in bold. A model cell holds one or more ids in
// backticks — `gpt-4.1-nano`, `gpt-4.1-nano-2025-04-14` or GPT-4o
// (`gpt-4o-2024-08-06`) — and every id in it shuts down on that date. Only an
// exact id matches: a dated snapshot shutting down says nothing about the
// alias that points at it.
//
// The model column also lists features. A fine-tuning shutdown ("Fine-tuning
// on `davinci`") ends training, not the model, so such a row names no model.
//
// The current shutdown comes first: upcoming ones before past ones, and past
// ones newest first. A model named twice takes the first date on the page.

import { ParseError, findLine, findTables, parseDate } from "../price.mjs";

const MODEL_COLUMN = "Affected model or feature";
const ID = /`([^`]+)`/gu;
const FINE_TUNING = /fine-tun/iu;
// "**Dec 11, 2026**": the bold is emphasis, the date is what is inside it.
const BOLD = /^\*\*([^*]+)\*\*$/u;

export function parseOpenaiDeprecations(text, { wanted }) {
  const lines = text.split("\n");
  findLine(lines, "# Deprecations", "deprecations");
  const tables = findTables(lines, "deprecations").filter((table) => table.header[0] === "Shutdown date");
  if (tables.length === 0) throw new ParseError('no "Shutdown date" tables');

  const retirements = new Map();
  for (const table of tables) {
    if (table.header[1] !== MODEL_COLUMN) {
      throw new ParseError(`a shutdown table has an unknown model column "${table.header[1]}"`);
    }
    for (const row of table.rows) {
      if (row.length !== table.header.length) {
        throw new ParseError(`a shutdown row has ${row.length} cells, its header ${table.header.length}`);
      }
      if (FINE_TUNING.test(row[1].replace(ID, ""))) continue;
      const date = BOLD.exec(row[0])?.[1] ?? row[0];
      for (const [, id] of row[1].matchAll(ID)) {
        if (wanted.has(id) && !retirements.has(id)) retirements.set(id, { date: parseDate(date, id) });
      }
    }
  }
  return retirements;
}
