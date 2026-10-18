// Only model choices are accepted from AI or PR data. Prices always come from
// the official parser, and every batch is validated before either file changes.
import { addModels } from "./catalog-edit.mjs";
import { kindFromLitellm, kindFromModelsDev, kindProblem, MODEL_KINDS } from "./kinds.mjs";
import { notAddedKey } from "./new-models.mjs";
import { catalogRates } from "./review.mjs";
import { SOURCES, sourceId } from "./sources.mjs";

export const REVIEW_BRANCH = "automation/update-models";
export const REVIEW_PATH = "scripts/models/review.json";
export const REVIEW_MARKER = "<!-- app-ai-gateway-model-update -->";
export const modelKey = ({ provider, model }) => `${provider}/${model}`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

const FIELDS = "action,model,origin,provider,reason,reviewer";

/**
 * A choice's `kind` is the model's kind once it is known, and `""` before it
 * is. Optional on the way in, so a review file written before kinds existed
 * still reads; `recommendModels` settles an addition's kind before
 * `applyChoices` will add it.
 */
export function validateChoices(value) {
  const seen = new Set();
  if (!Array.isArray(value) || value.length > 500) throw new Error("Model review must contain at most 500 choices.");
  for (const item of value) {
    const { kind = "", ...rest } = item ?? {};
    if (!item || Object.keys(rest).sort().join(",") !== FIELDS ||
        (kind !== "" && !MODEL_KINDS.includes(kind)) ||
        typeof item.provider !== "string" || typeof item.model !== "string" ||
        !Object.hasOwn(SOURCES, item.provider) || !SOURCES[item.provider].official || !ID.test(item.model) ||
        !["add", "skip", "pending"].includes(item.action) || !["ai", "manual", "rules"].includes(item.origin) ||
        typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 500 ||
        typeof item.reviewer !== "string" || item.reviewer.length > 100 || seen.has(modelKey(item))) {
      throw new Error("Invalid or duplicate model review choice.");
    }
    seen.add(modelKey(item));
  }
  return value;
}

/** What the community lists say a model does: `{ kind }`, `{ unsupported }`, or undefined. */
function listedKind(provider, model, lists) {
  const source = SOURCES[provider];
  return (source.litellm && kindFromLitellm(lists.litellm, source.litellm(model)))
    ?? (source.modelsDev && kindFromModelsDev(lists.modelsDev, source.modelsDev, model));
}

function metadata(provider, model, lists) {
  const source = SOURCES[provider];
  const entry = lists.modelsDev?.[source.modelsDev]?.models?.[model];
  const result = {};
  for (const key of ["name", "family", "status", "release_date"]) {
    if (typeof entry?.[key] === "string") result[key] = entry[key].slice(0, 150);
  }
  if (entry?.modalities) {
    for (const key of ["input", "output"]) {
      if (Array.isArray(entry.modalities[key])) result[key] = entry.modalities[key].filter((item) => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 30));
    }
  }
  return result;
}

export function collectCandidates({ newModels, official, deprecations = {}, lists, today }) {
  return newModels.flatMap(({ provider, ids }) => ids.map((model) => {
    if (!ID.test(model)) throw new Error("An official model ID cannot be represented in the catalog review.");
    const source = SOURCES[provider];
    const canonical = Object.entries(source.official.aliases ?? {}).find(([, alias]) => alias === model)?.[0] ?? model;
    const candidate = { provider, model, canonical, info: metadata(provider, canonical, lists) };
    let parsed;
    try {
      // Discovery parsers intentionally leave unrequested IDs unpriced. Read
      // each candidate separately so one unsupported format does not hide others.
      parsed = source.official.parse(official[provider].text, { wanted: new Set([model]), today }).get(model);
      candidate.price = catalogRates(parsed);
    } catch (error) {
      delete candidate.price;
      candidate.problem = `Unsupported public pricing: ${error.message}`.slice(0, 500);
    }
    if (candidate.price && source.author) {
      const author = source.author(model, parsed);
      if (author) {
        candidate.price.author = author;
        candidate.info.author = author;
      } else {
        delete candidate.price;
        candidate.problem = "The model's author is not confirmed in this provider's source configuration.";
      }
    }
    // The lists are community data, so what they say only proposes: the
    // price stays, and a person can still add the model with a kind of their
    // own. A listed kind its price cannot bill waits for one.
    const listed = listedKind(provider, canonical, lists);
    if (listed?.unsupported) {
      candidate.skip = `The gateway serves no ${listed.unsupported} models.`.slice(0, 500);
    } else if (listed?.kind) {
      candidate.kind = listed.kind;
      candidate.info.kind = listed.kind;
    }
    if (source.deprecations && deprecations[provider]?.text) {
      try {
        const id = sourceId(source.deprecations, canonical);
        const signal = source.deprecations.parse(deprecations[provider].text, { wanted: new Set([id]), today }).get(id);
        if (signal?.date) candidate.info.retirement_date = signal.date;
        else if (signal?.deprecated) candidate.info.status = "deprecated";
      } catch { /* The daily scan already reports failures of a deprecation source. */ }
    }
    return candidate;
  }));
}

export function applyChoices({ text, acknowledged, candidates, choices }) {
  validateChoices(choices);
  const byId = new Map(candidates.map((candidate) => [modelKey(candidate), candidate]));
  const catalog = JSON.parse(text);
  const additions = [];
  const acknowledgements = acknowledged.map((item) => ({ ...item }));
  for (const choice of choices) {
    const id = modelKey(choice);
    const candidate = byId.get(id);
    if (!candidate) throw new Error(`${id} is not a current discovery.`);
    if (Object.hasOwn(catalog[choice.provider], candidate.canonical)) throw new Error(`${id} is already in the shipped catalog.`);
    if (choice.action === "pending") continue;
    if (choice.action === "add" && !candidate.price) throw new Error(`${id}: ${candidate.problem}`);
    const key = notAddedKey(choice.provider, choice.model);
    const previous = acknowledgements.findIndex((item) => item.key === key);
    if (previous !== -1) acknowledgements.splice(previous, 1);
    if (choice.action === "skip") acknowledgements.push({ key, reason: choice.reason });
    else {
      const problem = choice.kind ? kindProblem(choice.kind, candidate.price) : "no kind is settled for this model";
      if (problem) throw new Error(`${id}: ${problem}.`);
      additions.push({ provider: choice.provider, model: candidate.canonical, price: { kind: choice.kind, ...candidate.price } });
    }
  }
  return { text: addModels(text, additions), acknowledged: acknowledgements };
}
