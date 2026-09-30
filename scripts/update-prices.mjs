// Checks every model in src/usage/prices.json against its provider's official
// pricing and deprecation pages, falling back to Models.dev and LiteLLM where
// there is no official source or its parser failed, and updates the prices
// and retirement dates that changed. Run daily by
// .github/workflows/update-prices.yml, which opens the pull request.
//
//   node scripts/update-prices.mjs [--dry-run] [--report <path>] [--today YYYY-MM-DD]
//
//   --dry-run  print the report and write nothing
//   --report   also write the Markdown report to <path>
//   --today    the date dated prices are resolved against (default: today, UTC)
//
// Exit code: 0 when nothing needs a person, 3 when something does (the report
// says what), 1 when the script itself failed.
//
// Everything fetched is untrusted. Nothing fetched is evaluated, and the only
// files written are prices.json and the report.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyEdits } from "./prices/catalog-edit.mjs";
import { ParseError } from "./prices/price.mjs";
import { renderReport } from "./prices/report.mjs";
import { catalogEdits, decide, needsHuman } from "./prices/rules.mjs";
import { LITELLM_URL, MODELS_DEV_URL, SOURCES, sourceId } from "./prices/sources.mjs";

const CATALOG = fileURLToPath(new URL("../src/usage/prices.json", import.meta.url));
const ACKNOWLEDGED = fileURLToPath(new URL("./prices/acknowledged.json", import.meta.url));
const USER_AGENT = "app-ai-gateway-price-sync (+https://github.com/maxceem/app-ai-gateway)";
const TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const options = { dryRun: false, report: null, today: new Date().toISOString().slice(0, 10) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--today") options.today = argv[++index];
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.report === undefined) throw new Error("--report needs a path");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.today ?? "")) throw new Error("--today needs YYYY-MM-DD");
  return options;
}

/** A page as text: one retry, a timeout, and the content type it must have. */
async function fetchText(url, type) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith(type)) throw new Error(`content type "${contentType}", expected ${type}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`fetch failed: ${lastError?.message ?? lastError}`);
}

/**
 * One official source read with its parser: `{ result }`, `{ error }` when
 * the page could not be fetched or read, or undefined when there is none.
 */
async function readSource(source, models, today) {
  if (!source) return undefined;
  const wanted = new Set(Object.keys(models).map((model) => sourceId(source, model)));
  let text;
  try {
    text = await fetchText(source.url, source.type);
  } catch (error) {
    return { error: error.message };
  }
  try {
    return { result: source.parse(text, { wanted, today }) };
  } catch (error) {
    if (error instanceof ParseError) return { error: error.message };
    throw error;
  }
}

async function readList(url, type) {
  try {
    return JSON.parse(await fetchText(url, type));
  } catch (error) {
    console.error(`${url}: ${error.message}`);
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readFile(CATALOG, "utf8");
  const catalog = JSON.parse(text);
  const acknowledged = JSON.parse(await readFile(ACKNOWLEDGED, "utf8"));
  const valid = (item) => typeof item?.key === "string" && typeof item?.reason === "string" && item.reason !== "";
  if (!Array.isArray(acknowledged) || !acknowledged.every(valid)) {
    throw new Error('scripts/prices/acknowledged.json must be a list of { "key": "…", "reason": "…" }');
  }

  const providers = Object.keys(catalog);
  const read = (kind) =>
    Promise.all(providers.map((provider) => readSource(SOURCES[provider]?.[kind], catalog[provider], options.today)));
  const [modelsDev, litellm, pricePages, deprecationPages] = await Promise.all([
    readList(MODELS_DEV_URL, "application/json"),
    readList(LITELLM_URL, "text/plain"),
    read("official"),
    read("deprecations"),
  ]);
  const byProvider = (pages, key) =>
    Object.fromEntries(
      providers.flatMap((provider, index) => {
        const page = pages[index];
        if (!page) return [];
        return [[provider, page.error !== undefined ? { error: page.error } : { [key]: page.result }]];
      }),
    );

  const decision = decide({
    catalog,
    official: byProvider(pricePages, "prices"),
    deprecations: byProvider(deprecationPages, "dates"),
    lists: { modelsDev, litellm },
    acknowledged,
    today: options.today,
  });
  const report = renderReport(decision);
  const updated = applyEdits(text, catalogEdits(decision));

  if (options.dryRun) {
    console.log(report);
  } else {
    if (updated !== text) await writeFile(CATALOG, updated);
    if (options.report) await writeFile(options.report, report);
    else console.log(report);
  }
  console.error(
    `${decision.changes.length} price change(s), ${decision.retirements.length} retirement date(s), ` +
      `${decision.attention.length} item(s) need attention`,
  );
  return needsHuman(decision) ? 3 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
