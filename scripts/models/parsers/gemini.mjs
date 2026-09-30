// https://ai.google.dev/gemini-api/docs/pricing.md.txt
//
// One "## " section per model family: a line of model ids in backticks, then
// "### Standard" and a three-column table of which only "Paid Tier" is read.
// A paid cell is one of a handful of exact shapes:
//
//   $1.50
//   $0.30 (text / image / video) $1.00 (audio)          the text price is read
//   $2.00, prompts \<= 200k tokens $4.00, prompts \> 200k tokens
//   $0.75 through December 31, 2026. $1.50 starting January 1, 2027.
//
// and the caching row also carries a storage price per hour, which is dropped.
// Anything else in a row this parser reads fails the page.

import { ParseError, decimal, parseDate, put, readTable } from "../price.mjs";

const HEADER = ["", "Free Tier", "Paid Tier, per 1M tokens in USD"];
const ROWS = {
  "Input price": "input",
  "Input price (text, image, video)": "input",
  "Output price (including thinking tokens)": "output",
  "Output price": "output",
  "Context caching price": "cached_input",
};

const IDS_LINE = /^\*\[`[^`]+`\]\([^)\s]+\)(?:(?:, |,? and )\[`[^`]+`\]\([^)\s]+\))*\*$/u;
const ID = /\[`([^`]+)`\]/gu;

const DATE = String.raw`([A-Z][a-z]+) (\d{1,2}), (\d{4})`;
const MONEY = String.raw`\$(\d+(?:\.\d+)?)`;

const STORAGE_UNIT = String.raw`${MONEY} \/ 1,000,000 tokens per hour \(storage price\)`;
const STORAGE = new RegExp(
  String.raw` ${STORAGE_UNIT}(?: through ${DATE}\. ${STORAGE_UNIT} starting ${DATE}\.)?$`,
  "u",
);
const PLAIN = new RegExp(String.raw`^${MONEY}$`, "u");
const MODALITY_SEGMENT = new RegExp(String.raw`${MONEY} \(([a-z]+(?: \/ [a-z]+)*)\)`, "gu");
const MODALITIES = new RegExp(String.raw`^${MONEY} \([a-z /]+\)(?: ${MONEY} \([a-z /]+\))*$`, "u");
const DATED = new RegExp(String.raw`^${MONEY} through ${DATE}\. ${MONEY} starting ${DATE}\.$`, "u");
const LONG = new RegExp(
  String.raw`^${MONEY}, prompts \\<= (\d+)k tokens ${MONEY}, prompts \\> (\d+)k(?: tokens)?$`,
  "u",
);

function nextDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * One paid cell as `{ value, long?, upcoming? }`. A dated cell resolves to the
 * price in effect `today` (UTC) and names the next one, if it is still ahead.
 */
export function readPaidCell(text, where, today) {
  let match = PLAIN.exec(text);
  if (match) return { value: decimal(match[1], where) };

  match = DATED.exec(text);
  if (match) {
    const until = parseDate(`${match[2]} ${match[3]}, ${match[4]}`, where);
    const from = parseDate(`${match[6]} ${match[7]}, ${match[8]}`, where);
    if (nextDay(until) !== from) {
      throw new ParseError(`${where}: the dated prices leave a gap or overlap (${until}, ${from})`);
    }
    const before = decimal(match[1], where);
    const after = decimal(match[5], where);
    return today < from ? { value: before, upcoming: { date: from, value: after } } : { value: after };
  }

  match = LONG.exec(text);
  if (match) {
    if (match[2] !== match[4]) throw new ParseError(`${where}: two different context thresholds`);
    return {
      value: decimal(match[1], where),
      long: { threshold: Number(match[2]) * 1000, value: decimal(match[3], where) },
    };
  }

  if (MODALITIES.test(text)) {
    const text_ = [...text.matchAll(MODALITY_SEGMENT)].filter((segment) =>
      segment[2].split(" / ").includes("text"),
    );
    if (text_.length !== 1) throw new ParseError(`${where}: "${text}" has no single text price`);
    return { value: decimal(text_[0][1], where) };
  }

  throw new ParseError(`${where}: unknown price format "${text}"`);
}

/** The storage price rides along in the caching cell; it is not billed per token. */
function withoutStorage(text, where) {
  const match = STORAGE.exec(text);
  if (!match) throw new ParseError(`${where}: the caching cell has no storage price "${text}"`);
  return text.slice(0, match.index);
}

function readSection(lines, where, today) {
  const standard = lines.findIndex((line) => line.trim() === "### Standard");
  if (standard === -1) throw new ParseError(`${where}: no "### Standard" table`);
  if (lines.slice(standard + 1).some((line) => line.trim() === "### Standard")) {
    throw new ParseError(`${where}: "### Standard" appears more than once`);
  }
  const cells = {};
  for (const row of readTable(lines, standard + 1, HEADER, where)) {
    const field = ROWS[row[0]];
    if (field === undefined) continue;
    if (cells[field] !== undefined) throw new ParseError(`${where}: two ${field} rows`);
    const text = field === "cached_input" ? withoutStorage(row[2], where) : row[2];
    cells[field] = readPaidCell(text, `${where}, ${row[0]}`, today);
  }
  if (!cells.input || !cells.output) throw new ParseError(`${where}: no input or output row`);

  const price = { input: cells.input.value, output: cells.output.value };
  if (cells.cached_input) price.cached_input = cells.cached_input.value;
  const thresholds = new Set(
    Object.values(cells).filter((cell) => cell.long).map((cell) => cell.long.threshold),
  );
  if (thresholds.size > 1) throw new ParseError(`${where}: rows disagree on the context threshold`);
  if (thresholds.size === 1) {
    if (!cells.input.long || !cells.output.long) {
      throw new ParseError(`${where}: a long-context price without its input or output`);
    }
    price.long_context_threshold = [...thresholds][0];
    price.long_input = cells.input.long.value;
    if (cells.cached_input?.long) price.long_cached_input = cells.cached_input.long.value;
    price.long_output = cells.output.long.value;
  }
  const upcoming = Object.entries(cells)
    .filter(([, cell]) => cell.upcoming)
    .map(([field, cell]) => ({ date: cell.upcoming.date, field, value: cell.upcoming.value }));
  if (upcoming.length > 0) price.upcoming = upcoming;
  return price;
}

export function parseGemini(text, { wanted, today }) {
  const lines = text.split("\n");
  const prices = new Map();
  const starts = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
  if (starts.length === 0) throw new ParseError("no model sections");

  for (const [position, start] of starts.entries()) {
    const section = lines.slice(start, starts[position + 1] ?? lines.length);
    const idsLine = section.slice(1).find((line) => line.trim() !== "")?.trim() ?? "";
    // A section that does not open with its model ids is not a model section
    // (tools, grounding, notes), and nothing in it is read.
    if (!idsLine.startsWith("*[`")) continue;
    if (!IDS_LINE.test(idsLine)) {
      throw new ParseError(`${section[0]}: unexpected model id line "${idsLine}"`);
    }
    const ids = [...idsLine.matchAll(ID)].map((match) => match[1]);
    if (!ids.some((id) => wanted.has(id))) {
      for (const id of ids) put(prices, id, null);
      continue;
    }
    const price = readSection(section, ids.join(", "), today);
    for (const id of ids) put(prices, id, price);
  }
  return prices;
}
