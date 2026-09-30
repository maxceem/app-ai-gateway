// https://developers.openai.com/api/docs/deprecations.md
//
// One table per announcement, upcoming and past alike, each opening with a
// "Shutdown date" column. A model cell holds one or more ids in backticks —
// `gpt-4.1-nano` \| `gpt-4.1-nano-2025-04-14` — and every id in it shuts
// down on that date. Only an exact id matches: a dated snapshot shutting down
// says nothing about the alias that points at it.
//
// Announcements are newest first, and a shutdown that was moved is announced
// again, so a model named twice takes the first date on the page.

import { ParseError, findLine, findTables, parseDate } from "../price.mjs";

const MODEL_COLUMNS = new Set([
  "Model / system",
  "Model family / snapshot",
  "Model snapshot",
  "Deprecated model",
  "System",
  "Legacy model",
]);
const ID = /`([^`]+)`/gu;

export function parseOpenaiDeprecations(text, { wanted }) {
  const lines = text.split("\n");
  findLine(lines, "# Deprecations", "deprecations");
  const tables = findTables(lines, "deprecations").filter((table) => table.header[0] === "Shutdown date");
  if (tables.length === 0) throw new ParseError('no "Shutdown date" tables');

  const retirements = new Map();
  for (const table of tables) {
    if (!MODEL_COLUMNS.has(table.header[1])) {
      throw new ParseError(`a shutdown table has an unknown model column "${table.header[1]}"`);
    }
    for (const row of table.rows) {
      if (row.length !== table.header.length) {
        throw new ParseError(`a shutdown row has ${row.length} cells, its header ${table.header.length}`);
      }
      for (const [, id] of row[1].matchAll(ID)) {
        if (wanted.has(id) && !retirements.has(id)) retirements.set(id, { date: parseDate(row[0], id) });
      }
    }
  }
  return retirements;
}
