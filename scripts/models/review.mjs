// Model review is explicit. A discovery never changes the catalog by itself.
import { addModels } from "./catalog-edit.mjs";
import { notAddedKey } from "./new-models.mjs";
import { AUDIO_FIELDS, PRICE_FIELDS } from "./price.mjs";
import { code, escape } from "./report.mjs";
import { SOURCES } from "./sources.mjs";
import { fetchText } from "./read-source.mjs";
import { MIN_PRICE, MAX_PRICE } from "./rules.mjs";

export const ISSUE_MARKER = "<!-- app-ai-gateway-model-review -->";
export const DECISION_MARKER = "<!-- app-ai-gateway-model-decisions -->";
export const DECISION_BRANCH = "automation/model-review-";

export function parseCommands(body) {
  if (body.length > 8000) throw new Error("Decision comments must be at most 8,000 characters.");
  const lines = body.trim().split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > 50) throw new Error("Use 1–50 /models commands, one per line.");
  const seen = new Set();
  return lines.map((line) => {
    const match = /^\/models (add|skip) ([a-z][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: (.+))?$/u.exec(line.trim());
    if (!match || (match[1] === "add" && match[4]) || (match[1] === "skip" && !match[4]?.trim())) {
      throw new Error("Use /models add provider/model or /models skip provider/model reason.");
    }
    const [, action, provider, model, reason] = match;
    if (!Object.hasOwn(SOURCES, provider) || !SOURCES[provider].official) throw new Error(`No official discovery source for ${provider}.`);
    const id = `${provider}/${model}`;
    if (seen.has(id)) throw new Error(`Two decisions for ${id}.`);
    seen.add(id);
    if ((reason?.length ?? 0) > 500) throw new Error("Skip reasons must be at most 500 characters.");
    return { action, provider, model, ...(reason && { reason: reason.trim() }) };
  });
}

/** Keep only the rates the gateway understands. Future rates are report-only. */
export function catalogRates(parsed) {
  if (!parsed || parsed.unpriced) throw new Error("The official source has no supported public price for this model.");
  const fields = [...PRICE_FIELDS, ...AUDIO_FIELDS, "long_context_threshold"];
  const price = Object.fromEntries(fields.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
  const audio = AUDIO_FIELDS.filter((field) => price[field] !== undefined);
  if (audio.length > 1 || (audio.length && (price.input !== undefined || price.output !== undefined))) throw new Error("Ambiguous billing units.");
  if (!audio.length && (price.input === undefined || price.output === undefined)) throw new Error("No supported input/output rates.");
  for (const [field, value] of Object.entries(price)) {
    if (!Number.isFinite(value) || value < 0 || (field === "long_context_threshold" ? !Number.isInteger(value) || value === 0 : value >= 1000)) {
      throw new Error(`Invalid ${field} rate.`);
    }
    if (PRICE_FIELDS.includes(field) && value !== 0 && (value <= MIN_PRICE || value >= MAX_PRICE)) throw new Error(`Suspicious ${field} rate.`);
  }
  if (price.long_context_threshold !== undefined && (price.long_input === undefined || price.long_output === undefined)) throw new Error("Incomplete long-context rates.");
  if (price.cached_input !== undefined && price.cached_input > price.input) throw new Error("Cached input is more expensive than input.");
  return price;
}

/** Validate the entire batch before writing either file. Pages are fetched fresh. */
export async function applyDecisions({ text, acknowledged, commands, pending = new Map(), today, loadPage = fetchText }) {
  const catalog = JSON.parse(text);
  const acknowledgements = acknowledged.map((item) => ({ ...item }));
  const additions = [];
  const pages = new Map();
  for (const provider of new Set(commands.map((item) => item.provider))) {
    const source = SOURCES[provider].official;
    const wanted = new Set(commands.filter((item) => item.provider === provider && item.action === "add").map((item) => item.model));
    const page = await loadPage(source.url, source.type);
    pages.set(provider, source.parse(page, { wanted, today }));
  }
  for (const command of commands) {
    const { action, provider, model, reason } = command;
    const id = `${provider}/${model}`;
    if (pending.has(id)) throw new Error(`${id} already has a decision awaiting merge: ${pending.get(id)}`);
    const source = SOURCES[provider].official;
    const canonical = Object.entries(source.aliases ?? {}).find(([, alias]) => alias === model)?.[0] ?? model;
    if (!Object.hasOwn(catalog, provider)) throw new Error(`Unknown catalog provider ${provider}.`);
    if (Object.hasOwn(catalog[provider], canonical)) {
      if (action === "add") continue; // A retry after merge is already fulfilled.
      throw new Error(`${id} is already in the catalog.`);
    }
    if (!pages.get(provider).has(model)) throw new Error(`${id} is not on its official discovery page.`);
    const key = notAddedKey(provider, model);
    const previous = acknowledgements.findIndex((item) => item.key === key);
    if (action === "skip" && previous !== -1 && acknowledgements[previous].reason === reason) continue;
    if (previous !== -1) acknowledgements.splice(previous, 1);
    if (action === "skip") acknowledgements.push({ key, reason });
    else additions.push({ provider, model: canonical, price: catalogRates(pages.get(provider).get(model)) });
  }
  return { text: addModels(text, additions), acknowledged: acknowledgements };
}

export function renderIssue(snapshot, pending = new Map()) {
  const rows = snapshot.newModels.flatMap(({ provider, ids }) => ids.map((model) => {
    const id = `${provider}/${model}`;
    const url = pending.get(id);
    return `| ${code(id)} | ${url ? `[Decision PR](${url}) — awaiting merge` : "Add or skip"} |`;
  }));
  const skipped = (snapshot.skippedModels ?? []).map(({ provider, model, reason }) => `- ${code(`${provider}/${model}`)}: ${escape(reason)}`);
  return `${ISSUE_MARKER}\n# New model review\n\n` +
    "New discoveries open the rolling catalog PR, which records their IDs for review without adding them. Models stay here until you add them or record why they should be skipped.\n\n" +
    "## Awaiting a decision\n\n" +
    (rows.length ? `| Model | Status |\n| --- | --- |\n${rows.join("\n")}` : "No undecided models on the last complete scan.") +
    "\n\n## Decide in a comment\n\nRepository members with write access can submit one or more commands, one per line:\n\n" +
    "```text\n/models add openai/gpt-6-luna\n/models skip openai/gpt-4o-2024-05-13 Older dated snapshot; prefer the current model\n```\n\n" +
    "Each command comment creates one decision PR; retries update that same PR. Add commands fetch current official rates. Skip commands save an exact model ID and a reason in `scripts/models/acknowledged.json`. Merge the PR to finalize your choices. Unselected models stay pending. Closing a decision PR leaves those models available for another decision.\n\n" +
    "Prefer current general-purpose models with supported metering. Review older snapshots and specialized billing formats before adding them.\n\n" +
    (skipped.length ? `## Deliberately skipped\n\n${skipped.join("\n")}\n\n` : "") +
    "This issue is refreshed by the daily scan. Checkbox edits do not apply decisions.\n";
}

export function renderDecision(commands, issueUrl) {
  const metadata = Buffer.from(JSON.stringify(commands)).toString("base64");
  return `${DECISION_MARKER}\n<!-- decisions:${metadata} -->\n` +
    `Apply explicit model decisions from [New model review](${issueUrl}).\n\n` +
    commands.map(({ action, provider, model, reason }) => `- **${action === "add" ? "Add" : "Skip"}** ${code(`${provider}/${model}`)}${reason ? ` — ${escape(reason)}` : ""}`).join("\n") +
    "\n\nAdded models use the current rates read from their official pricing source. Future rates are not scheduled. Existing catalog prices are unchanged.\n";
}

export function pendingDecisions(pulls, repository) {
  const pending = new Map();
  for (const pr of pulls) {
    if (pr.user?.login !== "github-actions[bot]" || pr.state !== "open" || pr.base?.ref !== "main" || pr.head?.repo?.full_name !== repository || !/^automation\/model-review-\d+$/u.test(pr.head?.ref ?? "") || !pr.body?.includes(DECISION_MARKER)) continue;
    const match = /<!-- decisions:([A-Za-z0-9+/=]+) -->/u.exec(pr.body);
    if (!match) continue;
    const commands = parseCommands(JSON.parse(Buffer.from(match[1], "base64").toString("utf8")).map(({ action, provider, model, reason }) => `/models ${action} ${provider}/${model}${reason ? ` ${reason}` : ""}`).join("\n"));
    for (const { provider, model } of commands) pending.set(`${provider}/${model}`, pr.html_url);
  }
  return pending;
}
