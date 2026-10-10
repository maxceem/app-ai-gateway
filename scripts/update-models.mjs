// Checks every model in src/usage/models.json against its provider's official
// pricing and deprecation pages, falling back to Models.dev and LiteLLM where
// there is no official source or its parser failed, and updates the prices
// that changed, including retirement dates only alongside a price update. New
// model IDs also open a review PR with AI add/skip suggestions. PR comments
// can override those choices; nothing is added until the PR is merged. Run daily by
// .github/workflows/update-models.yml, which opens the pull request.
//
//   node scripts/update-models.mjs [--dry-run] [--classify] [--report <path>] [--title <path>] [--review <path>] [--overrides <path>] [--today YYYY-MM-DD]
//
//   --dry-run  print the report and write nothing
//   --report   also write the Markdown report to <path>
//   --title    also write the pull request title to <path>
//   --classify call AI even in a dry run (paid inference; otherwise dry runs do not)
//   --review   read cached choices from the rolling PR
//   --overrides read validated choices from a PR comment
//   --today    the date dated prices are resolved against (default: today, UTC)
//
// Exit code: 0 when nothing needs a person, 3 when something does (the report
// says what), 1 when the script itself failed.
//
// Everything fetched is untrusted. Nothing fetched is evaluated, and the only
// files written are models.json, acknowledged.json, review.json and the report.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyEdits } from "./models/catalog-edit.mjs";
import { createClassifier, DEFAULT_REVIEW_MODEL, recommendModels } from "./models/ai-review.mjs";
import { applyChoices, collectCandidates, REVIEW_PATH, validateChoices } from "./models/choices.mjs";
import { fetchText, readSource } from "./models/read-source.mjs";
import { renderReport, renderTitle } from "./models/report.mjs";
import { catalogEdits, decide, needsHuman } from "./models/rules.mjs";
import { LITELLM_URL, MODELS_DEV_URL, SOURCES } from "./models/sources.mjs";

const CATALOG = fileURLToPath(new URL("../src/usage/models.json", import.meta.url));
const ACKNOWLEDGED = fileURLToPath(new URL("./models/acknowledged.json", import.meta.url));
const REVIEW = fileURLToPath(new URL(`../${REVIEW_PATH}`, import.meta.url));

function parseArgs(argv) {
  const options = { dryRun: false, classify: false, report: null, title: null, review: null, overrides: null, today: new Date().toISOString().slice(0, 10) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--classify") options.classify = true;
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--title") options.title = argv[++index];
    else if (arg === "--review") options.review = argv[++index];
    else if (arg === "--overrides") options.overrides = argv[++index];
    else if (arg === "--today") options.today = argv[++index];
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.review === undefined) throw new Error("--review needs a path");
  if (options.overrides === undefined) throw new Error("--overrides needs a path");
  if (options.report === undefined) throw new Error("--report needs a path");
  if (options.title === undefined) throw new Error("--title needs a path");
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
        return [[provider, page.error !== undefined ? { error: page.error } : { [key]: page.result, text: page.text }]];
      }),
    );

  const official = byProvider(pricePages, "prices");
  const deprecations = byProvider(deprecationPages, "dates");
  const lists = { modelsDev, litellm };
  const decision = decide({
    catalog,
    official, deprecations, lists,
    acknowledged,
    today: options.today,
  });
  const previous = validateChoices(JSON.parse(await readFile(options.review ?? REVIEW, "utf8")));
  const overrides = options.overrides ? validateChoices(JSON.parse(await readFile(options.overrides, "utf8"))) : [];
  const candidates = collectCandidates({ ...decision, official, deprecations, lists, today: options.today });
  const model = process.env.MODEL_REVIEW_MODEL || DEFAULT_REVIEW_MODEL;
  const mayClassify = !options.dryRun || options.classify;
  const classify = mayClassify && (process.env.MODEL_REVIEW_API_URL || process.env.MODEL_REVIEW_API_KEY)
    ? (batch, context) => createClassifier({ url: process.env.MODEL_REVIEW_API_URL, key: process.env.MODEL_REVIEW_API_KEY, model })(batch, context)
    : undefined;
  const recommendations = await recommendModels(candidates, { previous, overrides, classify, model, preview: options.dryRun,
    context: { today: options.today, catalog: Object.fromEntries(Object.entries(catalog).map(([provider, entries]) => [provider, Object.keys(entries)])), newModels: decision.newModels },
  });
  if (recommendations.error) decision.attention.push({ key: "model review: AI unavailable", text: recommendations.error });
  const report = renderReport({ ...decision, modelChoices: recommendations.choices });
  const updated = applyChoices({ text: applyEdits(text, catalogEdits(decision)), acknowledged, candidates, choices: recommendations.choices });

  if (options.dryRun) {
    console.log(report);
  } else {
    if (updated.text !== text) await writeFile(CATALOG, updated.text);
    if (JSON.stringify(updated.acknowledged) !== JSON.stringify(acknowledged)) await writeFile(ACKNOWLEDGED, `${JSON.stringify(updated.acknowledged, null, 2)}\n`);
    if (decision.newModels.length || decision.changes.length) await writeFile(REVIEW, `${JSON.stringify(recommendations.choices, null, 2)}\n`);
    if (options.report) await writeFile(options.report, report);
    else console.log(report);
    if (options.title) await writeFile(options.title, `${renderTitle(decision, options.today)}\n`);
  }
  console.error(
    `${decision.changes.length} price change(s), ${candidates.length} new model(s), ${decision.retirements.length} retirement date(s), ` +
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
