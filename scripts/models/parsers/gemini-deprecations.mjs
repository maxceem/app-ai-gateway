// https://ai.google.dev/gemini-api/docs/deprecations.md.txt
//
// One table per model family, with a shutdown date or "No shutdown date
// announced" for every model. Google calls these dates the earliest a model
// may be shut down, so a date here can move later, never earlier.

import { ParseError, findTables, parseDate, put } from "../price.mjs";

const HEADER = ["**Model**", "**Release date**", "**Shutdown date**", "**Recommended replacement**"];
const MODEL = /^`([^`]+)`$/u;

export function parseGeminiDeprecations(text, { wanted }) {
  const tables = findTables(text.split("\n"), "deprecations").filter((table) =>
    table.header.every((cell, index) => cell === HEADER[index]) && table.header.length === HEADER.length,
  );
  if (tables.length === 0) throw new ParseError("no model tables");

  const retirements = new Map();
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.length !== HEADER.length) throw new ParseError(`a row has ${row.length} cells`);
      const model = MODEL.exec(row[0]);
      if (!model) {
        // A group label such as "Preview models" spans the row.
        if (row.slice(1).every((cell) => cell === "")) continue;
        throw new ParseError(`unexpected model cell "${row[0]}"`);
      }
      const id = model[1];
      if (!wanted.has(id) || row[2] === "No shutdown date announced") continue;
      put(retirements, id, { date: parseDate(row[2], id) });
    }
  }
  return retirements;
}
