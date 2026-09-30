import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyEdits, formatPrice } from "../scripts/prices/catalog-edit.mjs";
import { fromLitellm, fromModelsDev } from "../scripts/prices/lists.mjs";
import { parseAnthropic } from "../scripts/prices/parsers/anthropic.mjs";
import { parseCerebras } from "../scripts/prices/parsers/cerebras.mjs";
import { parseDeepseek } from "../scripts/prices/parsers/deepseek.mjs";
import { parseGemini } from "../scripts/prices/parsers/gemini.mjs";
import { parseGroq } from "../scripts/prices/parsers/groq.mjs";
import { parseMoonshot } from "../scripts/prices/parsers/moonshot.mjs";
import { parseOpenai } from "../scripts/prices/parsers/openai.mjs";
import { parsePerplexity } from "../scripts/prices/parsers/perplexity.mjs";
import { parseTogether } from "../scripts/prices/parsers/together.mjs";
import { parseXai } from "../scripts/prices/parsers/xai.mjs";
import { ParseError, effectivePrice, samePrice } from "../scripts/prices/price.mjs";
import { renderReport } from "../scripts/prices/report.mjs";
import { compare, decide, needsHuman } from "../scripts/prices/rules.mjs";
import { SOURCES } from "../scripts/prices/sources.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/prices/${name}`, import.meta.url), "utf8");
const catalogText = readFileSync(new URL("../src/usage/prices.json", import.meta.url), "utf8");
const TODAY = "2026-09-30";

function parse(parser, text, wanted, today = TODAY) {
  return parser(text, { wanted: new Set(wanted), today });
}

/** Runs `parser` on a mutated fixture and expects the page to fail. */
function assertFails(parser, text, wanted, pattern) {
  assert.throws(() => parse(parser, text, wanted), (error) => {
    assert.ok(error instanceof ParseError, `expected a ParseError, got ${error}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function replaceOnce(text, from, to) {
  assert.ok(text.includes(from), `fixture does not contain "${from}"`);
  return text.replace(from, to);
}

// Parsers -------------------------------------------------------------------

test("openai: reads the standard, specialized and transcription tables", () => {
  const text = fixture("openai.md");
  const wanted = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-4o-transcribe", "Whisper"];
  const prices = parse(parseOpenai, text, wanted);
  assert.deepEqual(prices.get("gpt-5.6-sol"), {
    input: 4,
    output: 20,
    cached_input: 0.4,
    cache_write: 5,
    long_context_threshold: 272000,
    long_input: 8,
    long_cached_input: 0.8,
    long_cache_write: 10,
    long_output: 30,
  });
  assert.deepEqual(prices.get("gpt-5.5"), {
    input: 5,
    output: 30,
    cached_input: 0.5,
    long_context_threshold: 272000,
    long_input: 10,
    long_cached_input: 1,
    long_output: 45,
  });
  assert.deepEqual(prices.get("gpt-5.4-mini"), { input: 0.75, output: 4.5, cached_input: 0.075 });
  // The standard specialized table, not the Fast one below it.
  assert.deepEqual(prices.get("gpt-5.3-codex"), { input: 1.75, output: 14, cached_input: 0.175 });
  assert.deepEqual(prices.get("gpt-4o-transcribe"), { input: 2.5, output: 10 });
  assert.deepEqual(prices.get("Whisper"), { per_minute: 0.006 });
  // Listed but not read, so unknown cells such as "Free" do not matter.
  assert.equal(prices.get("gpt-6-astra"), null);
  assert.equal(prices.get("omni-moderation-latest"), null);
});

test("openai: fails on a renamed header, an added column, an unknown cell or a duplicate", () => {
  const text = fixture("openai.md");
  const wanted = ["gpt-5.6-sol"];
  assertFails(parseOpenai, replaceOnce(text, "| Model | Short context input |", "| Model | Short-context input |"), wanted, /header changed/);
  assertFails(
    parseOpenai,
    text.replace(/\| Long context output \|\n\| --- /u, "| Long context output | Notes |\n| --- | --- "),
    wanted,
    /header changed/,
  );
  assertFails(parseOpenai, replaceOnce(text, "| gpt-5.6-sol | $4.00 |", "| gpt-5.6-sol | 4.00 USD |"), wanted, /not a price/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-5.6-sol | $4.00 |", "| gpt-5.6-sol | $4 00 |"), wanted, /plain decimal/);
  assertFails(parseOpenai, replaceOnce(text, "Short context: ≤272K", "Short context: ≤256K"), wanted, /threshold/);
  assertFails(
    parseOpenai,
    replaceOnce(text, "| gpt-5.4-mini |", "| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | - | - | - | - |\n| gpt-5.4-mini |"),
    wanted,
    /twice/,
  );
  assertFails(parseOpenai, replaceOnce(text, "Transcription models", "Speech models"), wanted, /missing/);
});

test("anthropic: reads display names, footnotes and the 5-minute cache write", () => {
  const prices = parse(parseAnthropic, fixture("anthropic.md"), ["claude-mythos-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  assert.deepEqual(prices.get("claude-mythos-5"), { input: 10, cached_input: 1, cache_write: 12.5, output: 50 });
  assert.deepEqual(prices.get("claude-sonnet-5"), { input: 2, cached_input: 0.2, cache_write: 2.5, output: 10 });
  assert.deepEqual(prices.get("claude-haiku-4-5"), { input: 1, cached_input: 0.1, cache_write: 1.25, output: 5 });
  assert.equal(prices.get("claude-opus-5-5"), null);
  assert.equal(prices.get("claude-opus-4-1"), null);
});

test("anthropic: fails on a changed header or price grammar", () => {
  const text = fixture("anthropic.md");
  const wanted = ["claude-haiku-4-5"];
  assertFails(parseAnthropic, replaceOnce(text, "| 5m cache writes |", "| 5-minute cache writes |"), wanted, /header changed/);
  assertFails(parseAnthropic, replaceOnce(text, "| $1 / MTok             | $1.25", "| $1 per MTok           | $1.25"), wanted, /MTok/);
  assertFails(parseAnthropic, replaceOnce(text, "## Model pricing", "## Models"), wanted, /missing/);
});

test("gemini: reads dated, long-context and per-modality prices", () => {
  const text = fixture("gemini.md");
  const wanted = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-2.5-flash"];
  const prices = parse(parseGemini, text, wanted);
  assert.deepEqual(prices.get("gemini-3.6-flash"), {
    input: 0.75,
    output: 3.75,
    cached_input: 0.075,
    upcoming: [
      { date: "2027-01-01", field: "input", value: 1.5 },
      { date: "2027-01-01", field: "output", value: 7.5 },
      { date: "2027-01-01", field: "cached_input", value: 0.15 },
    ],
  });
  assert.deepEqual(prices.get("gemini-3.5-flash"), { input: 1.5, output: 9, cached_input: 0.15 });
  const pro = {
    input: 2,
    output: 12,
    cached_input: 0.2,
    long_context_threshold: 200000,
    long_input: 4,
    long_cached_input: 0.4,
    long_output: 18,
  };
  assert.deepEqual(prices.get("gemini-3.1-pro-preview"), pro);
  assert.deepEqual(prices.get("gemini-3.1-pro-preview-customtools"), pro);
  assert.deepEqual(prices.get("gemini-2.5-flash"), { input: 0.3, output: 2.5, cached_input: 0.03 });
  // An image model's cells are not a token grammar, and are not read.
  assert.equal(prices.get("gemini-3-pro-image"), null);
});

test("gemini: a dated price switches on its day", () => {
  const text = fixture("gemini.md");
  const lastDay = parse(parseGemini, text, ["gemini-3.6-flash"], "2026-12-31").get("gemini-3.6-flash");
  assert.equal(lastDay.input, 0.75);
  assert.equal(lastDay.upcoming.length, 3);
  const firstDay = parse(parseGemini, text, ["gemini-3.6-flash"], "2027-01-01").get("gemini-3.6-flash");
  assert.deepEqual(firstDay, { input: 1.5, output: 7.5, cached_input: 0.15 });
});

test("gemini: fails on an unknown cell, a changed header or a dated gap", () => {
  const text = fixture("gemini.md");
  assertFails(parseGemini, text, ["gemini-3-pro-image"], /unknown price format/);
  assertFails(parseGemini, replaceOnce(text, "| $1.50 |", "| $1.50 per million |"), ["gemini-3.5-flash"], /unknown price format/);
  assertFails(
    parseGemini,
    text.replaceAll("Paid Tier, per 1M tokens in USD", "Paid Tier (USD)"),
    ["gemini-3.5-flash"],
    /header changed/,
  );
  assertFails(
    parseGemini,
    replaceOnce(text, "$0.75 through December 31, 2026. $1.50 starting January 1, 2027.", "$0.75 through December 30, 2026. $1.50 starting January 1, 2027."),
    ["gemini-3.6-flash"],
    /gap/,
  );
  assertFails(parseGemini, replaceOnce(text, "$0.15 $1.00 / 1,000,000", "$0.15 $1.00 / 1M"), ["gemini-3.5-flash"], /storage/);
});

test("xai: pairs long-context rows and reads speech to text per hour", () => {
  const text = fixture("xai.md");
  const prices = parse(parseXai, text, ["grok-4.5", "Speech to Text"]);
  assert.deepEqual(prices.get("grok-4.5"), {
    input: 2,
    cached_input: 0.3,
    output: 6,
    long_context_threshold: 200000,
    long_input: 4,
    long_cached_input: 0.6,
    long_output: 12,
  });
  assert.deepEqual(prices.get("Speech to Text"), { per_hour: 0.1 });
  assert.equal(prices.get("grok-4.7"), null);
  assert.equal(prices.has("grok-imagine-image"), false);
  assertFails(parseXai, replaceOnce(text, "| grok-4.5 (≥ 200k prompt tokens) | 500k | $4.00 | $0.60 | $12.00 |\n", ""), ["grok-4.5"], /long-context row/);
  assertFails(parseXai, replaceOnce(text, "$0.10 / hr (REST)", "$0.10 per hour (REST)"), ["Speech to Text"], /speech to text/);
});

test("together: reads escaped prices by API model string", () => {
  const text = fixture("together.md");
  const prices = parse(parseTogether, text, ["moonshotai/Kimi-K3", "openai/gpt-oss-120b"]);
  assert.deepEqual(prices.get("moonshotai/Kimi-K3"), { input: 3, cached_input: 0.3, output: 15 });
  assert.deepEqual(prices.get("openai/gpt-oss-120b"), { input: 0.15, output: 0.6 });
  assert.equal(prices.get("Prism-ML/Ternary-Bonsai-27B"), null);
  assertFails(parseTogether, text, ["Prism-ML/Ternary-Bonsai-27B"], /not a price/);
  assertFails(parseTogether, replaceOnce(text, "| API model string |", "| Model string |"), ["openai/gpt-oss-120b"], /header changed/);
});

test("groq: reads the link id, token, hourly and contact-sales prices", () => {
  const text = fixture("groq.md");
  const prices = parse(parseGroq, text, ["openai/gpt-oss-120b", "whisper-large-v3", "llama-3.3-70b-versatile", "qwen/qwen3.8-27b"]);
  assert.deepEqual(prices.get("openai/gpt-oss-120b"), { input: 0.15, output: 0.6 });
  assert.deepEqual(prices.get("whisper-large-v3"), { per_hour: 0.111 });
  assert.deepEqual(prices.get("qwen/qwen3.8-27b"), { input: 0.8, output: 4 });
  assert.ok(prices.get("llama-3.3-70b-versatile").unpriced);
  assertFails(parseGroq, text, ["canopylabs/orpheus-arabic-saudi"], /unknown price format/);
  assertFails(parseGroq, replaceOnce(text, "## [Preview Models](#preview-models)", "## Preview"), ["openai/gpt-oss-120b"], /missing/);
});

test("moonshot: reads each DocTable layout without evaluating it", () => {
  const text = fixture("moonshot.md");
  const prices = parse(parseMoonshot, text, ["kimi-k3", "kimi-k2.6"]);
  assert.deepEqual(prices.get("kimi-k3"), { input: 3, output: 15, cached_input: 0.3, cache_write: 3 });
  assert.deepEqual(prices.get("kimi-k2.6"), { input: 0.95, output: 4, cached_input: 0.16 });
  assert.equal(prices.get("kimi-k2.7-code"), null);
  assertFails(parseMoonshot, replaceOnce(text, '"Cached Input Price"', '"Cache Hit Price"'), ["kimi-k3"], /unknown table columns/);
  assertFails(parseMoonshot, replaceOnce(text, '<>{"$"}0.16</>', '<>{"$"}{0.16}</>'), ["kimi-k2.6"], /unexpected cell/);
  assertFails(parseMoonshot, replaceOnce(text, '"kimi-k2.6", "1M tokens"', '"kimi-k2.6", "1K tokens"'), ["kimi-k2.6"], /unit/);
});

test("deepseek: reads the PEAK row of the transposed table", () => {
  const text = fixture("deepseek.html");
  const prices = parse(parseDeepseek, text, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.deepEqual(prices.get("deepseek-flash"), { input: 0.3, cached_input: 0.006, output: 1.2 });
  assert.deepEqual(prices.get("deepseek-v4-pro"), { input: 1.32, cached_input: 0.044, output: 3.96 });
  assertFails(parseDeepseek, text.replaceAll("<td>PEAK</td>", "<td>STANDARD</td>"), ["deepseek-flash"], /PEAK/);
  assertFails(parseDeepseek, replaceOnce(text, "<td>$1.2</td>", "<td>$1.2 USD</td>"), ["deepseek-flash"], /not a price/);
});

test("perplexity: parses the sonar object as JSON, never as code", () => {
  const text = fixture("perplexity.md");
  const prices = parse(parsePerplexity, text, ["sonar", "sonar-pro", "sonar-deep-research"]);
  assert.deepEqual(prices.get("sonar"), { input: 1, output: 1 });
  assert.deepEqual(prices.get("sonar-deep-research"), { input: 2, output: 8 });
  // Braces inside strings do not end the object.
  const braces = replaceOnce(text, '"label": "Sonar Pro"', '"label": "Sonar } Pro {"');
  assert.deepEqual(parse(parsePerplexity, braces, ["sonar-pro"]).get("sonar-pro"), { input: 3, output: 15 });
  assertFails(parsePerplexity, replaceOnce(text, '"label": "Sonar",', '"label": "Sonar", "cache": 0.1,'), ["sonar"], /unknown keys/);
  assertFails(parsePerplexity, replaceOnce(text, '"input": 1,', '"input": 1 + 1,'), ["sonar"], /not JSON/);
  assertFails(parsePerplexity, replaceOnce(text, "$ per 1,000,000 tokens\",\n      \"sonar.request", "$ per 1,000 tokens\",\n      \"sonar.request"), ["sonar"], /unit/);
});

test("cerebras: converts $ per token strings to $ per 1M", () => {
  const text = fixture("cerebras.json");
  const prices = parse(parseCerebras, text, ["gpt-oss-120b"]);
  assert.deepEqual(prices.get("gpt-oss-120b"), { input: 0.35, output: 0.75 });
  assertFails(parseCerebras, replaceOnce(text, '"0.00000035"', '"3.5e-7"'), ["gpt-oss-120b"], /decimal/);
});

test("lists: Models.dev and LiteLLM read into the same shape", () => {
  const modelsDev = JSON.parse(fixture("models-dev.json"));
  const litellm = JSON.parse(fixture("litellm.json"));
  const fromMd = fromModelsDev(modelsDev, "openai", "gpt-5.6-sol");
  const fromLl = fromLitellm(litellm, "gpt-5.6-sol");
  assert.deepEqual(fromMd, {
    input: 4,
    output: 20,
    cached_input: 0.4,
    cache_write: 5,
    long_context_threshold: 272000,
    long_input: 8,
    long_cached_input: 0.8,
    long_cache_write: 10,
    long_output: 30,
  });
  assert.ok(samePrice(fromMd, fromLl));
  assert.ok(samePrice(fromModelsDev(modelsDev, "google", "gemini-2.5-pro"), fromLitellm(litellm, "gemini/gemini-2.5-pro")));
  assert.deepEqual(fromLitellm(litellm, "whisper-1"), { per_minute: 0.006 });
  assert.equal(fromModelsDev(modelsDev, "openai", "constructor"), undefined);
  assert.equal(fromLitellm(litellm, "constructor"), undefined);
});

// Rules ---------------------------------------------------------------------

test("effective prices follow computeCost's fallbacks", () => {
  assert.ok(samePrice({ input: 1, output: 2 }, { input: 1, cached_input: 1, cache_write: 1, output: 2 }));
  assert.ok(!samePrice({ input: 1, output: 2 }, { input: 1, cached_input: 0.1, output: 2 }));
  // Long-context cached input falls back to the base cached price first.
  assert.deepEqual(
    effectivePrice({ input: 1, cached_input: 0.1, output: 2, long_context_threshold: 1000, long_input: 2 }),
    {
      input: 1,
      output: 2,
      cached_input: 0.1,
      cache_write: 1,
      long_input: 2,
      long_output: 2,
      long_cached_input: 0.1,
      long_cache_write: 2,
    },
  );
  assert.ok(!samePrice({ input: 1, output: 2 }, { input: 1, output: 2, long_context_threshold: 1000 }));
  assert.deepEqual(compare({ input: 1, output: 2 }, { input: 1, cached_input: 1, output: 2 }), { edits: [] });
});

const page = (entries) => ({ prices: new Map(Object.entries(entries)) });
const noLists = { modelsDev: {}, litellm: {} };
const mdList = (provider, models) => ({ [provider]: { models: Object.fromEntries(Object.entries(models).map(([id, cost]) => [id, { cost }])) } });
const llList = (entries) =>
  Object.fromEntries(
    Object.entries(entries).map(([key, price]) => [
      key,
      { input_cost_per_token: price.input / 1e6, output_cost_per_token: price.output / 1e6 },
    ]),
  );

const cases = [
  {
    name: "official equal: nothing to do",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    changes: [],
    attention: [],
  },
  {
    name: "official different: update",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1.5, output: 2 } }) },
    changes: [["cerebras/a", "input", 1, 1.5, "official"]],
    attention: [],
  },
  {
    name: "official missing: reported, and the lists are not consulted",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    lists: { modelsDev: mdList("cerebras", { b: { input: 5, output: 6 } }), litellm: llList({ "cerebras/b": { input: 5, output: 6 } }) },
    changes: [],
    attention: ["cerebras/b: not on official page"],
  },
  {
    name: "under half found: the parser fails and the lists answer",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 }, c: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    changes: [],
    attention: ["cerebras: parser failed"],
    noSource: ["cerebras/a", "cerebras/b", "cerebras/c"],
  },
  {
    name: "parser failed, lists agree: update from the lists",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: { error: "the table header changed" } },
    lists: { modelsDev: mdList("cerebras", { a: { input: 1.25, output: 2 } }), litellm: llList({ "cerebras/a": { input: 1.25, output: 2 } }) },
    changes: [["cerebras/a", "input", 1, 1.25, "models.dev + litellm"]],
    attention: ["cerebras: parser failed"],
  },
  {
    name: "lists disagree: no update",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: mdList("mistral", { a: { input: 1.25, output: 2 } }), litellm: llList({ "mistral/a": { input: 1.5, output: 2 } }) },
    changes: [],
    attention: ["mistral/a: lists disagree"],
  },
  {
    name: "only one list, and it differs: no update",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: mdList("mistral", { a: { input: 1.25, output: 2 } }), litellm: {} },
    changes: [],
    attention: ["mistral/a: only one list"],
  },
  {
    name: "only one list, and it agrees: nothing to report",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: {}, litellm: llList({ "mistral/a": { input: 1, output: 2 } }) },
    changes: [],
    attention: [],
  },
  {
    name: "no source at all: informational",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    changes: [],
    attention: [],
    noSource: ["mistral/a"],
  },
  {
    name: "a price our entry has no field for: reported, not edited",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1.5, cached_input: 0.15, output: 2 } }) },
    changes: [],
    attention: ["cerebras/a: needs a new field"],
  },
  {
    name: "a different long-context threshold: reported, not edited",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0, long_context_threshold: 200000, long_input: 2.0, long_output: 4.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2, long_context_threshold: 272000, long_input: 2, long_output: 4 } }) },
    changes: [],
    attention: ["cerebras/a: threshold differs"],
  },
  {
    name: "a move of more than 3x: suspicious, not applied",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 8 } }) },
    changes: [],
    attention: ["cerebras/a: suspicious change"],
  },
  {
    name: "a price outside the per-1M band: suspicious, not applied",
    catalog: { cerebras: { a: { input: 0.002, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 0.001, output: 2 } }) },
    changes: [],
    attention: ["cerebras/a: suspicious change"],
  },
  {
    name: "an acknowledged item no longer needs a person",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    acknowledged: [{ key: "cerebras/b: not on official page", reason: "kept for existing apps" }],
    changes: [],
    attention: [],
    acknowledged_: ["cerebras/b: not on official page"],
  },
  {
    name: "an audio price is compared in its own unit",
    catalog: { groq: { w: { per_hour: 0.111 }, x: { input: 1.0, output: 2.0 } } },
    official: { groq: page({ w: { per_hour: 0.04 }, x: { input: 1, output: 2 } }) },
    changes: [["groq/w", "per_hour", 0.111, 0.04, "official"]],
    attention: [],
  },
];

for (const scenario of cases) {
  test(`rules: ${scenario.name}`, () => {
    const decision = decide({
      catalog: scenario.catalog,
      official: scenario.official ?? {},
      lists: scenario.lists ?? noLists,
      acknowledged: scenario.acknowledged ?? [],
    });
    assert.deepEqual(
      decision.changes.map((change) => [`${change.provider}/${change.model}`, change.field, change.from, change.to, change.source]),
      scenario.changes,
    );
    assert.deepEqual(decision.attention.map((item) => item.key), scenario.attention);
    assert.equal(needsHuman(decision), scenario.attention.length > 0);
    if (scenario.noSource) {
      assert.deepEqual(decision.noSource.map((item) => `${item.provider}/${item.model}`), scenario.noSource);
    }
    if (scenario.acknowledged_) {
      assert.deepEqual(decision.acknowledged.map((item) => item.key), scenario.acknowledged_);
    }
  });
}

test("rules: a dated price is applied on its day and announced before it", () => {
  const catalog = { gemini: { "gemini-3.6-flash": { input: 1.5, cached_input: 0.15, output: 7.5 } } };
  const run = (today) =>
    decide({
      catalog,
      official: { gemini: { prices: parse(parseGemini, fixture("gemini.md"), ["gemini-3.6-flash"], today) } },
      lists: noLists,
    });
  const before = run("2026-12-31");
  assert.deepEqual(before.changes.map((change) => [change.field, change.to]), [["input", 0.75], ["cached_input", 0.075], ["output", 3.75]]);
  assert.deepEqual(before.upcoming.map((item) => [item.field, item.value, item.date]), [
    ["input", 1.5, "2027-01-01"],
    ["output", 7.5, "2027-01-01"],
    ["cached_input", 0.15, "2027-01-01"],
  ]);
  assert.equal(needsHuman(before), false);
  const after = run("2027-01-01");
  assert.deepEqual(after.changes, []);
  assert.deepEqual(after.upcoming, []);
});

test("sources: every catalog provider has an entry", () => {
  for (const provider of Object.keys(JSON.parse(catalogText))) {
    assert.ok(SOURCES[provider], `scripts/prices/sources.mjs has no entry for ${provider}`);
  }
});

// Catalog editor ------------------------------------------------------------

test("catalog editor: no edits leave the file byte for byte", () => {
  assert.equal(applyEdits(catalogText, []), catalogText);
});

test("catalog editor: one edit changes exactly one literal", () => {
  const edited = applyEdits(catalogText, [{ provider: "openai", model: "gpt-5.6-sol", field: "input", to: 4 }]);
  const before = catalogText.split("\n");
  const after = edited.split("\n");
  assert.equal(after.length, before.length);
  const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
  assert.deepEqual(changed, [['      "input": 5.0,', '      "input": 4.0,']]);
  // gpt-5.6, the entry just above with the same prices, is untouched.
  assert.equal(JSON.parse(edited).openai["gpt-5.6"].input, 5);
});

test("catalog editor: numbers are written short and without float noise", () => {
  assert.equal(formatPrice(0.1 + 0.2), "0.3");
  assert.equal(formatPrice(4), "4.0");
  assert.equal(formatPrice(0.075), "0.075");
});

test("catalog editor: a model id with braces or quotes does not confuse it", () => {
  const text = '{\n  "p": {\n    "a{\\"}b": { "input": 1.0, "output": 2.0 },\n    "x": { "input": 1.0, "output": 2.0 }\n  }\n}\n';
  const edited = applyEdits(text, [{ provider: "p", model: "x", field: "input", to: 1.5 }]);
  assert.equal(edited, text.replace('"x": { "input": 1.0', '"x": { "input": 1.5'));
  const quoted = applyEdits(text, [{ provider: "p", model: 'a{"}b', field: "output", to: 3 }]);
  assert.equal(quoted, text.replace('"a{\\"}b": { "input": 1.0, "output": 2.0', '"a{\\"}b": { "input": 1.0, "output": 3.0'));
});

test("catalog editor: refuses to add a field", () => {
  assert.throws(
    () => applyEdits(catalogText, [{ provider: "openai", model: "gpt-5-pro", field: "cached_input", to: 1 }]),
    /missing/,
  );
});

// Report --------------------------------------------------------------------

test("report: fetched text is escaped", () => {
  const report = renderReport({
    changes: [{ provider: "p", model: "m`|<b>", field: "input", from: 1, to: 2, source: "official" }],
    attention: [{ key: "p: parser failed", text: 'official parser failed: "<img src=x onerror=alert(1)>" | [link](https://evil) `x`' }],
    acknowledged: [],
    upcoming: [],
    noSource: [],
    newModels: [{ provider: "p", ids: ["</details><script>", "a`b"] }],
    sources: [{ provider: "p", text: "official failed → lists" }],
  });
  assert.doesNotMatch(report, /<img|<script|<b>/u);
  assert.doesNotMatch(report, /(?<!\\)\[link\]/u, "a fetched link must not render as one");
  assert.match(report, /&lt;img/u);
  const row = report.split("\n").find((line) => line.startsWith("| `p/m"));
  assert.equal(row.split(/(?<!\\)\|/u).length, 6, "the model id must not add a table cell");
  assert.match(report, /## Price changes[\s\S]*## Needs attention[\s\S]*## Sources[\s\S]*New on official pages/u);
});
