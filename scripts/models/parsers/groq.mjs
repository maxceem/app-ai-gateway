// https://console.groq.com/docs/models.md
//
// The production and preview model tables. The model id is the path of the
// cell's `/docs/model/<id>` link; the price cell reads `$0.15 input$0.60 output`,
// `$0.111 per hour` for speech, or `ContactSales` for a model with no public
// price.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const HEADER = [
  "MODEL ID",
  "SPEED (T/SEC)",
  "PRICE PER 1M TOKENS",
  "RATE LIMITS (DEVELOPER PLAN)",
  "CONTEXT WINDOW (TOKENS)",
  "MAX COMPLETION TOKENS",
  "MAX FILE SIZE",
];
const TABLES = [
  "## [Production Models](#production-models)",
  "## [Preview Models](#preview-models)",
];

const MODEL_LINK = /\]\(\/docs\/model\/([a-z0-9][a-z0-9./-]*)\)/gu;
const TOKENS = /^\$(\S+) input\$(\S+) output$/u;
const PER_HOUR = /^\$(\S+) per hour$/u;

export function parseGroq(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();
  for (const heading of TABLES) {
    const start = findLine(lines, heading, heading);
    // A note paragraph sits between the heading and the table.
    let tableStart = start + 1;
    while (tableStart < lines.length && !lines[tableStart].trim().startsWith("|")) {
      if (lines[tableStart].startsWith("## ")) throw new ParseError(`${heading}: the table is missing`);
      tableStart += 1;
    }
    for (const row of readTable(lines, tableStart, HEADER, heading)) {
      const links = [...row[0].matchAll(MODEL_LINK)];
      if (links.length !== 1) throw new ParseError(`${heading}: no single model link in "${row[0]}"`);
      const id = links[0][1];
      if (!wanted.has(id)) {
        put(prices, id, null);
        continue;
      }
      const where = `${heading}, ${id}`;
      const cell = row[2];
      let match;
      if (cell === "ContactSales") {
        put(prices, id, { unpriced: "the page says to contact sales" });
      } else if ((match = TOKENS.exec(cell))) {
        put(prices, id, { input: decimal(match[1], where), output: decimal(match[2], where) });
      } else if ((match = PER_HOUR.exec(cell))) {
        put(prices, id, { per_hour: decimal(match[1], where) });
      } else {
        throw new ParseError(`${where}: unknown price format "${cell}"`);
      }
    }
  }
  return prices;
}
