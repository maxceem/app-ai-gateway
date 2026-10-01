// Checks every model in src/usage/models.json against its provider's official
// pricing and deprecation pages, falling back to Models.dev and LiteLLM where
// there is no official source or its parser failed, and updates the prices
// that changed, including retirement dates only alongside a price update. New
// model IDs also open a review PR; add/skip decisions remain explicit. Run daily by
// .github/workflows/update-models.yml, which opens the pull request.
//
//   node scripts/update-models.mjs [--dry-run] [--report <path>] [--review <path>] [--today YYYY-MM-DD]
//
//   --dry-run  print the report and write nothing
//   --report   also write the Markdown report to <path>
//   --review   also write discovery data for the rolling review issue
//   --today    the date dated prices are resolved against (default: today, UTC)
//
// Exit code: 0 when nothing needs a person, 3 when something does (the report
// says what), 1 when the script itself failed.
//
// Everything fetched is untrusted. Nothing fetched is evaluated, and the only
// files written are models.json, notified.json, the report and discovery data.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyEdits } from "./models/catalog-edit.mjs";
import { discoveryUpdate } from "./models/new-models.mjs";
import { fetchText, readSource } from "./models/read-source.mjs";
import { renderReport } from "./models/report.mjs";
import { catalogEdits, decide, needsHuman } from "./models/rules.mjs";
import { LITELLM_URL, MODELS_DEV_URL, SOURCES } from "./models/sources.mjs";

const CATALOG = fileURLToPath(new URL("../src/usage/models.json", import.meta.url));
const ACKNOWLEDGED = fileURLToPath(new URL("./models/acknowledged.json", import.meta.url));
const NOTIFIED = fileURLToPath(new URL("./models/notified.json", import.meta.url));

function parseArgs(argv) {
  const options = { dryRun: false, report: null, review: null, today: new Date().toISOString().slice(0, 10) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--review") options.review = argv[++index];
    else if (arg === "--today") options.today = argv[++index];
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.review === undefined) throw new Error("--review needs a path");
  if (options.report === undefined) throw new Error("--report needs a path");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.today ?? "")) throw new Error("--today needs YYYY-MM-DD");
  return options;
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
    throw new Error('scripts/models/acknowledged.json must be a list of { "key": "…", "reason": "…" }');
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
  const notified = JSON.parse(await readFile(NOTIFIED, "utf8"));
  const discoveries = discoveryUpdate(decision.newModels, notified);
  const report = renderReport({ ...decision, notifications: discoveries.notifications });
  const updated = applyEdits(text, catalogEdits(decision));

  if (options.dryRun) {
    console.log(report);
  } else {
    if (updated !== text) await writeFile(CATALOG, updated);
    if (discoveries.notifications.length) await writeFile(NOTIFIED, `${JSON.stringify(discoveries.notified, null, 2)}\n`);
    if (options.report) await writeFile(options.report, report);
    else console.log(report);
    if (options.review) await writeFile(options.review, JSON.stringify({
      newModels: decision.newModels,
      skippedModels: decision.skippedModels,
      complete: decision.sources.every(({ provider, text }) => !SOURCES[provider]?.official || text.startsWith("prices: official OK")),
    }));
  }
  console.error(
    `${decision.changes.length} price change(s), ${discoveries.notifications.reduce((count, { ids }) => count + ids.length, 0)} new model(s), ${decision.retirements.length} retirement date(s), ` +
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
