// https://platform.claude.com/docs/en/about-claude/model-deprecations.md
//
// The "## Model status" table: every current and recently retired model by
// API name, its state, and its retirement date. An active model's date reads
// "Not sooner than …", which is a promise, not a schedule, so it is not read.

import { ParseError, findLine, parseDate, put, readTable } from "../price.mjs";

const HEADER = ["API model name", "Current state", "Deprecated", "Tentative retirement date"];
const NOT_SOONER = /^Not sooner than (.+)$/u;

export function parseAnthropicDeprecations(text, { wanted }) {
  const lines = text.split("\n");
  const heading = findLine(lines, "## Model status", "model status");
  let start = heading + 1;
  while (lines[start]?.trim() === "") start += 1;
  if (!lines[start]?.trim().startsWith("|")) start += 1;

  const retirements = new Map();
  for (const [id, state, , retirement] of readTable(lines, start, HEADER, "model status")) {
    if (!wanted.has(id)) continue;
    const where = `model status, ${id}`;
    if (state === "Active") {
      const promise = NOT_SOONER.exec(retirement);
      if (!promise) throw new ParseError(`${where}: an active model with "${retirement}"`);
      parseDate(promise[1], where);
    } else if (state === "Deprecated" && retirement === "To be announced") {
      put(retirements, id, { deprecated: true });
    } else if (state === "Deprecated" || state === "Retired") {
      put(retirements, id, { date: parseDate(retirement, where) });
    } else {
      throw new ParseError(`${where}: unknown state "${state}"`);
    }
  }
  return retirements;
}
