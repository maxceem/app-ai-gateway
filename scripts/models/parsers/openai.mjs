// https://developers.openai.com/api/docs/pricing.md
//
// Three tables are read: "Standard pricing data" (not Batch, Flex, Fast or
// Ultrafast), the Standard table of the specialized models, where the Codex
// and embedding models live, and the transcription models. An embedding model
// generates nothing, so its missing output price is 0.

import { ParseError, decimal, findLine, findNextLine, put, readTable } from "../price.mjs";

const TOKEN_HEADER = [
  "Model",
  "Short context input",
  "Short context cached input",
  "Short context cache writes",
  "Short context output",
  "Long context input",
  "Long context cached input",
  "Long context cache writes",
  "Long context output",
];
const SPECIALIZED_HEADER = ["Category", "Model", "Input", "Cached input", "Output"];
const TRANSCRIPTION_HEADER = ["Model", "Use case", "Input", "Output", "Estimated cost"];

const THRESHOLD_NOTE = /^Short context: ≤(\d+)K input tokens\. Long context: >(\d+)K input tokens\.$/u;
const MODEL_CELL = /^([a-z0-9][a-z0-9.-]*)(?: \(<(\d+)K context length\))?$/u;
const PER_MINUTE = /^\$(\S+) \/ minute$/u;

function cell(text, where) {
  if (text === "-") return undefined;
  if (!text.startsWith("$")) throw new ParseError(`${where}: "${text}" is not a price`);
  return decimal(text.slice(1), where);
}

export function parseOpenai(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();

  const notes = lines.map((line) => THRESHOLD_NOTE.exec(line.trim())).filter(Boolean);
  if (notes.length !== 1 || notes[0][1] !== notes[0][2]) {
    throw new ParseError("the short/long context threshold note changed");
  }
  const threshold = Number(notes[0][1]) * 1000;

  const standard = findLine(lines, "### Standard pricing data", "standard pricing");
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
    const [input, cachedInput, cacheWrite, output, longInput, longCached, longWrite, longOutput] =
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
    const [input, cachedInput, listedOutput] = row.slice(2).map((value) => cell(value, where));
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

  // Realtime has independent text/audio and cached-modality rates. Never collapse audio into text.
  const realtime = lines.findIndex(line => line.trim() === "Realtime and audio generation models");
  if (realtime >= 0) {
    const heading = findNextLine(lines, "### Grouped Pricing Table data", "realtime models", realtime);
    const entries = new Map();
    for (const row of readTable(lines, heading + 1, ["Model", "Modality", "Input", "Cached input", "Output / cost"], "realtime models")) {
      if (!wanted.has(row[0]) || !["Text", "Audio"].includes(row[1])) continue;
      const price = entries.get(row[0]) ?? {};
      const [input, cached, output] = row.slice(2).map(value => cell(value, `realtime models, ${row[0]}`));
      if (row[1] === "Text") { if (input !== undefined) price.input = input; if (output !== undefined) price.output = output; if (cached !== undefined) price.cached_input = cached; }
      else { if (input !== undefined) price.audio_input = input; if (output !== undefined) price.audio_output = output; if (cached !== undefined) price.cached_audio_input = cached; }
      entries.set(row[0], price);
    }
    for (const [model, price] of entries) {
      if (price.input === undefined || price.output === undefined) throw new ParseError(`realtime models, ${model}: incomplete text rates`);
      put(prices, model, price);
    }
  }

  return prices;
}
