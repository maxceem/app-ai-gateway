// https://ai.google.dev/gemini-api/docs/pricing.md.txt
//
// One "## " section per model family: a line of model ids in backticks, then
// "### Standard" and a three-column table of which only "Paid Tier" is read.
// A paid cell is one of a handful of exact shapes:
//
//   $1.50
//   $0.45 ($0.00012 per image)                          the per-unit figure is dropped
//   $0.30 (text / image / video) $1.00 (audio)          the text price is read
//   $12.00 (text and thinking) $120.00 (images)         and an image-only price
//   $20.00 (audio)                                      one price for everything
//   $2.00, prompts \<= 200k tokens $4.00, prompts \> 200k tokens
//   $0.75 through December 31, 2026. $1.50 starting January 1, 2027.
//   $0.50 (text) through December 31, 2026. $1.00 (text) starting January 1, 2027.
//
// A per-modality or dated cell may end in "Equivalent to $0.134 per 1K image",
// which restates the price per image or per second and is dropped; so is the
// storage price per hour the caching row carries. Anything else in a row this
// parser reads fails the page. An image-only price is kept only on the output
// row, as `image_output`: generated image tokens bill at it, everything else at
// the text price. Any other modality priced beside text on the output row fails
// the page.
//
// An embedding model's table has no output row, and one input row per
// modality instead; those become `input` and `image_input`, `audio_input` and
// `video_input`, with `output` 0.

import { ParseError, decimal, parseDate, put, readTable } from "../price.mjs";

const HEADER = ["", "Free Tier", "Paid Tier, per 1M tokens in USD"];
const ROWS = {
  "Input price": "input",
  "Input price (text, image, video)": "input",
  "Output price (including thinking tokens)": "output",
  "Output price": "output",
  "Context caching price": "cached_input",
  "Text input price": "input",
  "Image input price": "image_input",
  "Audio input price": "audio_input",
  "Video input price": "video_input",
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
const MODALITY = String.raw`[a-z]+(?:(?: ?\/ ?|, | and )[a-z]+)*`;
const MODALITY_SEGMENT = new RegExp(String.raw`${MONEY} \((${MODALITY})\)`, "gu");
const MODALITIES = new RegExp(String.raw`^${MONEY} \(${MODALITY}\)(?: ${MONEY} \(${MODALITY}\))*$`, "u");
// A dated restatement would hide a price change, so one never counts as one,
// except after a dated cell, which states the same change itself.
const EQUIVALENT = /,? [Ee]quivalent to \$(?:(?!through|starting).)*$/u;
const DATED_EQUIVALENT = new RegExp(
  String.raw` Equivalent to \$[\d.]+ per [^.]+? through ${DATE}\. Equivalent to \$[\d.]+ per [^.]+? starting ${DATE}\.$`,
  "u",
);
const PER_UNIT = /^(\$\d+(?:\.\d+)?) \(\$\d+(?:\.\d+)? per [a-z]+\)$/u;
// A dated cell names at most one modality, so its price is the whole row's.
const LABEL = String.raw`(?: \(([a-z][a-z ,/]*)\))?`;
const DATED = new RegExp(
  String.raw`^${MONEY}${LABEL} through ${DATE}\. ${MONEY}${LABEL} starting ${DATE}\.$`,
  "u",
);
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
  let match = PLAIN.exec(text.replace(PER_UNIT, "$1"));
  if (match) return { value: decimal(match[1], where) };

  match = DATED.exec(text.replace(DATED_EQUIVALENT, ""));
  if (match) {
    if (match[2] !== match[7]) throw new ParseError(`${where}: the dated prices name different modalities`);
    const until = parseDate(`${match[3]} ${match[4]}, ${match[5]}`, where);
    const from = parseDate(`${match[8]} ${match[9]}, ${match[10]}`, where);
    if (nextDay(until) !== from) {
      throw new ParseError(`${where}: the dated prices leave a gap or overlap (${until}, ${from})`);
    }
    const before = decimal(match[1], where);
    const after = decimal(match[6], where);
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

  const stated = text.replace(EQUIVALENT, "");
  if (MODALITIES.test(stated)) {
    const segments = [...stated.matchAll(MODALITY_SEGMENT)].map((segment) => ({
      value: segment[1],
      modalities: segment[2].split(/ ?\/ ?|, | and /u).map((name) => (name === "images" ? "image" : name)),
    }));
    // A row priced for one modality alone has nothing else to bill: a speech
    // model's output is audio, and its audio price is every output token's.
    if (segments.length === 1) return { value: decimal(segments[0].value, where) };
    const text_ = segments.filter((segment) => segment.modalities.includes("text"));
    if (text_.length !== 1) throw new ParseError(`${where}: "${text}" has no single text price`);
    const image = segments.filter((segment) => segment.modalities.length === 1 && segment.modalities[0] === "image");
    if (image.length > 1) throw new ParseError(`${where}: "${text}" has two image prices`);
    const others = segments.length - text_.length - image.length;
    return {
      value: decimal(text_[0].value, where),
      ...(image.length === 1 && { image: decimal(image[0].value, where) }),
      ...(others > 0 && { others: true }),
    };
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
  let embedding = false;
  for (const row of readTable(lines, standard + 1, HEADER, where)) {
    if (row[0] === "Text input price") embedding = true;
    const field = ROWS[row[0]];
    if (field === undefined) continue;
    if (cells[field] !== undefined) throw new ParseError(`${where}: two ${field} rows`);
    const text = field === "cached_input" ? withoutStorage(row[2], where) : row[2];
    cells[field] = readPaidCell(text, `${where}, ${row[0]}`, today);
  }
  // An embedding model generates nothing, so it has no output to price.
  if (embedding && !cells.output) cells.output = { value: 0 };
  if (!cells.input || !cells.output) throw new ParseError(`${where}: no input or output row`);
  if (!embedding && (cells.image_input || cells.audio_input || cells.video_input)) {
    throw new ParseError(`${where}: a per-modality input row without a text input row`);
  }
  // Usage says how many output tokens were images and nothing else, so an
  // output price for audio or video would bill that output as text.
  if (cells.output.others) throw new ParseError(`${where}: an output price for a modality that is not metered`);

  const price = { input: cells.input.value, output: cells.output.value };
  if (cells.output.image !== undefined) price.image_output = cells.output.image;
  for (const field of ["image_input", "audio_input", "video_input"]) {
    if (cells[field]) price[field] = cells[field].value;
  }
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
