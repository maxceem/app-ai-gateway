// https://console.groq.com/docs/deprecations.md
//
// One table per announcement under "Deprecation History", newest first, dates
// written month first as `09/14/26`. A model announced twice (a shutdown that
// was moved) takes its newest announcement, which is the first one on the page.

import { ParseError, findLine, findTables, parseDate } from "../price.mjs";

const MODEL_COLUMNS = new Set(["Deprecated Model", "Model ID"]);
const MODEL = /^`?([a-z0-9][a-z0-9./-]*)`?$/u;

export function parseGroqDeprecations(text, { wanted }) {
  const lines = text.split("\n");
  findLine(lines, "## [Deprecation History](#deprecation-history)", "deprecation history");
  const tables = findTables(lines, "deprecation history").filter((table) => table.header[1] === "Shutdown Date");
  if (tables.length === 0) throw new ParseError('no "Shutdown Date" tables');

  const retirements = new Map();
  for (const table of tables) {
    if (!MODEL_COLUMNS.has(table.header[0]) || table.header.length !== 3) {
      throw new ParseError(`unexpected shutdown table header "${table.header.join(" | ")}"`);
    }
    for (const row of table.rows) {
      if (row.length !== 3) throw new ParseError(`a shutdown row has ${row.length} cells`);
      const model = MODEL.exec(row[0]);
      if (!model) throw new ParseError(`unexpected model cell "${row[0]}"`);
      if (wanted.has(model[1]) && !retirements.has(model[1])) {
        retirements.set(model[1], { date: parseDate(row[1], model[1]) });
      }
    }
  }
  return retirements;
}
