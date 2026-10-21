// https://developers.openai.com/api/docs/pricing.md
//
// The tables read are every "Standard pricing data" one (not Batch, Flex, Fast
// or Ultrafast), each with the plain input/output table that may follow it
// for models without long-context or cache-write prices, the Standard table
// of the specialized models, where the Codex and embedding models live, the
// transcription models, and the Standard table of the image generation
// models. An embedding model generates nothing, so its missing output price
// is 0. Cache writes are priced for a 30-minute and a 12-hour lifetime; the
// catalog prices the default 30-minute write, so the 12-hour columns are not
// read.
//
// The image table prices each model twice, a Text row and an Image row. Text
// input is `input` and image input `image_input`. A model whose Text row has
// no output generates only images, so its image output is its `output`; one
// that also writes text keeps the image rate apart as `image_output`. Usage
// counts cached tokens without saying which modality they were, so the higher
// of the two cached rates is the model's `cached_input`, rather than let a
// cached image bill at the cheaper text rate.

import { ParseError, decimal, findLine, findNextLine, put, readTable } from "../price.mjs";

const TOKEN_HEADER = [
  "Model",
  "Short context input",
  "Short context output",
  "Short context cached input",
  "Short context 30m write",
  "Short context 12h write",
  "Long context input",
  "Long context output",
  "Long context cached input",
  "Long context 30m write",
  "Long context 12h write",
];
const PLAIN_HEADER = ["Model", "Input", "Output", "Cached input"];
const SPECIALIZED_HEADER = ["Category", "Model", "Input", "Output", "Cached input"];
const TRANSCRIPTION_HEADER = ["Model", "Use case", "Input", "Output", "Estimated cost"];
const IMAGE_HEADER = ["Model", "Modality", "Input", "Output", "Cached input"];
const IMAGE_MODALITIES = ["Text", "Image"];

const THRESHOLD_NOTE = /^Short context: ≤(\d+)K input tokens\. Long context: >(\d+)K input tokens\.$/u;
const MODEL_CELL = /^([a-z0-9][a-z0-9.-]*)(?: \(<(\d+)K context length\))?$/u;
const PER_MINUTE = /^\$(\S+) \/ minute$/u;

function cell(text, where) {
  if (text === "-") return undefined;
  if (!text.startsWith("$")) throw new ParseError(`${where}: "${text}" is not a price`);
  return decimal(text.slice(1), where);
}

/** The index of the first line after the table that starts at or after `start`. */
function tableEnd(lines, start) {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  while (index < lines.length && lines[index].trim().startsWith("|")) index += 1;
  return index;
}

/** The index of the next table's header when only blank lines lead to it, or -1. */
function adjacentTable(lines, start) {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return lines[index]?.trim().startsWith("|") ? index : -1;
}

export function parseOpenai(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();

  const notes = lines.map((line) => THRESHOLD_NOTE.exec(line.trim())).filter(Boolean);
  if (notes.length !== 1 || notes[0][1] !== notes[0][2]) {
    throw new ParseError("the short/long context threshold note changed");
  }
  const threshold = Number(notes[0][1]) * 1000;

  // One heading per model family, and the plain table under one goes on
  // without a heading of its own, so it is read only when blank lines alone
  // separate it from the table above.
  const standards = lines.flatMap((line, index) => (line.trim() === "### Standard pricing data" ? [index] : []));
  if (standards.length === 0) throw new ParseError('standard pricing: "### Standard pricing data" is missing');
  for (const standard of standards) {
    for (const row of readTable(lines, standard + 1, TOKEN_HEADER, "standard pricing")) {
      const model = MODEL_CELL.exec(row[0]);
      if (!model) throw new ParseError(`standard pricing: unexpected model cell "${row[0]}"`);
      const id = model[1];
      if (model[2] !== undefined && Number(model[2]) * 1000 !== threshold) {
        throw new ParseError(`${id}: its context note disagrees with the page threshold`);
      }
      if (!wanted.has(id)) {
        put(prices, id, null);
        continue;
      }
      const where = `standard pricing, ${id}`;
      const [input, output, cachedInput, cacheWrite, , longInput, longOutput, longCached, longWrite] =
        row.slice(1).map((value) => cell(value, where));
      if (input === undefined || output === undefined) {
        throw new ParseError(`${where}: no input or output price`);
      }
      const price = { input, output };
      if (cachedInput !== undefined) price.cached_input = cachedInput;
      if (cacheWrite !== undefined) price.cache_write = cacheWrite;
      const long = [longInput, longCached, longWrite, longOutput];
      if (long.some((value) => value !== undefined)) {
        if (longInput === undefined || longOutput === undefined) {
          throw new ParseError(`${where}: a long-context price without its input or output`);
        }
        price.long_context_threshold = threshold;
        price.long_input = longInput;
        if (longCached !== undefined) price.long_cached_input = longCached;
        if (longWrite !== undefined) price.long_cache_write = longWrite;
        price.long_output = longOutput;
      } else if (model[2] !== undefined) {
        throw new ParseError(`${where}: a context note without long-context prices`);
      }
      put(prices, id, price);
    }

    const plain = adjacentTable(lines, tableEnd(lines, standard + 1));
    if (plain === -1) continue;
    for (const row of readTable(lines, plain, PLAIN_HEADER, "standard pricing")) {
      const id = row[0];
      if (!MODEL_CELL.test(id) || id.includes("(")) {
        throw new ParseError(`standard pricing: unexpected model cell "${id}"`);
      }
      if (!wanted.has(id)) {
        put(prices, id, null);
        continue;
      }
      const where = `standard pricing, ${id}`;
      const [input, output, cachedInput] = row.slice(1).map((value) => cell(value, where));
      if (input === undefined || output === undefined) {
        throw new ParseError(`${where}: no input or output price`);
      }
      const price = { input, output };
      if (cachedInput !== undefined) price.cached_input = cachedInput;
      put(prices, id, price);
    }
  }

  // Both the specialized and the transcription tables sit under a plain-text
  // section title and a heading every grouped table on the page shares, so the
  // unique title is the landmark and the next heading after it is the table.
  const specialized = findLine(lines, "Specialized models", "specialized models");
  const specializedTable = findNextLine(lines, "### Grouped Pricing Table data", "specialized models", specialized);
  for (const row of readTable(lines, specializedTable + 1, SPECIALIZED_HEADER, "specialized models")) {
    const id = row[1];
    if (!MODEL_CELL.test(id) || id.includes("(")) {
      throw new ParseError(`specialized models: unexpected model cell "${id}"`);
    }
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `specialized models, ${id}`;
    const [input, listedOutput, cachedInput] = row.slice(2).map((value) => cell(value, where));
    const embedding = row[0] === "Embedding";
    if (embedding && (cachedInput !== undefined || listedOutput !== undefined)) {
      throw new ParseError(`${where}: an embedding model with a cached or output price`);
    }
    const output = embedding ? 0 : listedOutput;
    if (input === undefined || output === undefined) {
      throw new ParseError(`${where}: no input or output price`);
    }
    const price = { input, output };
    if (cachedInput !== undefined) price.cached_input = cachedInput;
    put(prices, id, price);
  }

  const transcription = findLine(lines, "Transcription models", "transcription models");
  const transcriptionTable = findNextLine(lines, "### Grouped Pricing Table data", "transcription models", transcription);
  for (const row of readTable(lines, transcriptionTable + 1, TRANSCRIPTION_HEADER, "transcription models")) {
    // The page names whisper-1 "Whisper"; sources.mjs maps it.
    const id = row[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(id)) {
      throw new ParseError(`transcription models: unexpected model cell "${id}"`);
    }
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `transcription models, ${id}`;
    const input = cell(row[2], where);
    const output = cell(row[3], where);
    if (input !== undefined && output !== undefined) {
      put(prices, id, { input, output });
    } else if (input === undefined && output === undefined) {
      const minute = PER_MINUTE.exec(row[4]);
      if (!minute) throw new ParseError(`${where}: "${row[4]}" is not a per-minute price`);
      put(prices, id, { per_minute: decimal(minute[1], where) });
    } else {
      throw new ParseError(`${where}: only one of input and output is priced`);
    }
  }

  // The Standard table is the first one under the title, Batch the next; the
  // unit line is checked too, because a per-image table would read just as well.
  const images = findLine(lines, "Image generation models", "image generation models");
  const imageTable = findNextLine(lines, "### Grouped Pricing Table data", "image generation models", images);
  const preamble = lines.slice(images + 1, imageTable).map((line) => line.trim());
  if (!preamble.includes("Prices per 1M tokens.") || !preamble.includes("Standard") || preamble.includes("Batch")) {
    throw new ParseError("image generation models: the first table is not the Standard per-1M-token one");
  }
  const imageRows = new Map();
  for (const row of readTable(lines, imageTable + 1, IMAGE_HEADER, "image generation models")) {
    const [id, modality] = row;
    if (!MODEL_CELL.test(id) || id.includes("(")) {
      throw new ParseError(`image generation models: unexpected model cell "${id}"`);
    }
    if (!IMAGE_MODALITIES.includes(modality)) {
      throw new ParseError(`image generation models, ${id}: unexpected modality "${modality}"`);
    }
    const rows = imageRows.get(id) ?? {};
    if (rows[modality]) throw new ParseError(`image generation models, ${id}: two ${modality} rows`);
    rows[modality] = row;
    imageRows.set(id, rows);
  }
  for (const [id, rows] of imageRows) {
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `image generation models, ${id}`;
    if (!rows.Text || !rows.Image) throw new ParseError(`${where}: needs both a Text and an Image row`);
    const [input, textOutput, cachedText] = rows.Text.slice(2).map((value) => cell(value, where));
    const [imageInput, imageOutput, cachedImage] = rows.Image.slice(2).map((value) => cell(value, where));
    if (input === undefined || imageInput === undefined || imageOutput === undefined) {
      throw new ParseError(`${where}: no text input, image input or image output price`);
    }
    if ((cachedText === undefined) !== (cachedImage === undefined)) {
      throw new ParseError(`${where}: only one modality has a cached price`);
    }
    const price = { input, output: textOutput ?? imageOutput, image_input: imageInput };
    if (textOutput !== undefined) price.image_output = imageOutput;
    if (cachedText !== undefined) price.cached_input = Math.max(cachedText, cachedImage);
    put(prices, id, price);
  }

  return prices;
}
