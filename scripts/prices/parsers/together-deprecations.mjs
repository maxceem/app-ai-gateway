// https://docs.together.ai/docs/deprecations.md
//
// Two tables: models scheduled for removal from serverless inference, and the
// history of models already removed, most recent first. The history records
// what happened, so it wins when both name a model, and within it a model
// removed twice takes its most recent removal, the first on the page. The
// fine-tuning history is not read.

import { ParseError, findTables, parseDate } from "../price.mjs";

const SCHEDULED = ["Removal date", "Model", "Recommended replacement", "Supported by on-demand dedicated endpoints"];
const HISTORY = ["Removal date", "Model", "Supported by on-demand dedicated endpoints"];
const MODEL = /^`([^`]+)`$/u;

function matching(tables, header) {
  return tables.filter(
    (table) => table.header.length === header.length && table.header.every((cell, index) => cell === header[index]),
  );
}

function read(table, wanted) {
  const retirements = new Map();
  for (const row of table.rows) {
    if (row.length !== table.header.length) throw new ParseError(`a row has ${row.length} cells`);
    // A closing notes row spans the table with the other cells empty.
    if (row.slice(1).every((cell) => cell === "")) continue;
    const model = MODEL.exec(row[1]);
    if (!model) throw new ParseError(`unexpected model cell "${row[1]}"`);
    if (wanted.has(model[1]) && !retirements.has(model[1])) {
      retirements.set(model[1], { date: parseDate(row[0], model[1]) });
    }
  }
  return retirements;
}

export function parseTogetherDeprecations(text, { wanted }) {
  const tables = findTables(text.split("\n"), "deprecations");
  const history = matching(tables, HISTORY);
  const scheduled = matching(tables, SCHEDULED);
  if (history.length !== 1) throw new ParseError(`expected one inference history table, found ${history.length}`);
  if (scheduled.length > 1) throw new ParseError(`expected at most one scheduled table, found ${scheduled.length}`);

  const retirements = scheduled.length === 1 ? read(scheduled[0], wanted) : new Map();
  for (const [id, retirement] of read(history[0], wanted)) retirements.set(id, retirement);
  return retirements;
}
