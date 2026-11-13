// The Markdown report that becomes the model prices pull request's body and the
// workflow's step summary, in three parts: what merging applies (✅), what a
// person has to resolve (❌), and everything else, for information (ℹ️). Empty
// sections are left out.
//
// Much of what it quotes came from a fetched page (a parser's reason, a model
// id a page lists), so every value goes through `escape` before it is placed
// in Markdown: nothing a page says can become a link, an image, HTML or a
// broken table.
import { SOURCES } from "./sources.mjs";
import { REVIEW_MARKER } from "./choices.mjs";

/** Makes text inert in Markdown, inside or outside a table cell. */
export function escape(value) {
  return String(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]|]/gu, (char) => `\\${char}`);
}

export function code(value) {
  // Inside a code span nothing is interpreted, but a backtick would end it, a
  // pipe would still split a table cell, and a renderer that is not strict
  // CommonMark might still read a tag. None of them belongs in a model id.
  const text = String(value)
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("`", "'")
    .replaceAll("|", "¦")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  return `\`${text}\``;
}

function list(items, line) {
  return items.map((item) => `- ${line(item)}`).join("\n");
}

function details(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

// A table cell GitHub must not wrap: word joiners between the boxes, which it
// would otherwise break between, and no-break spaces.
const NO_BREAK = "\u00a0";
const glue = (text) => [...text].join("\u2060");

/**
 * A price change as five boxes of 20% each, sized against today's price. A
 * rise fills 🟥 with what it adds, and past double keeps adding them, up to
 * triple; a drop fills 🟩 with what is still paid. Any change fills at least
 * one box, and leaves at least one empty, so it never looks like none.
 */
export function priceBar(from, to) {
  if (to < from) {
    const kept = Math.min(4, Math.max(1, Math.round((to / from) * 5)));
    return "🟩".repeat(kept) + "⬜".repeat(5 - kept);
  }
  if (to === from) return "⬜".repeat(5);
  const added = Math.max(1, Math.round((to / from - 1) * 5));
  if (added > 10) return "🟥".repeat(10) + "➕";
  return "🟥".repeat(added) + "⬜".repeat(Math.max(0, 5 - added));
}

function priceChange(from, to) {
  if (!(from > 0)) return "new price";
  const percent = Math.round(Math.abs(to / from - 1) * 100);
  const sign = to > from ? "+" : to < from ? "−" : "";
  return `${glue(priceBar(from, to))}${NO_BREAK}**${sign}${percent}%**`;
}

/**
 * One table per date, earliest first, so no date has to fit in a column. A
 * model's name is given on its first row only.
 */
function upcomingTables(upcoming) {
  const dates = [...new Set(upcoming.map((item) => item.date))].sort();
  return dates
    .map((date) => {
      let previous;
      const rows = upcoming
        .filter((item) => item.date === date)
        .map((item) => {
          const name = `${item.provider}/${item.model}`;
          const model = name === previous ? "" : code(name);
          previous = name;
          const prices = item.from === undefined ? `**$${item.value}**` : `$${item.from}${NO_BREAK}→${NO_BREAK}**$${item.value}**`;
          return `| ${model} | ${escape(item.field)} | ${prices} | ${priceChange(item.from, item.value)} |`;
        });
      return `**From ${escape(date)}**\n\n| Model | Field | Today → new | Change |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The pull request's title: what it holds and the day it was checked, e.g.
 * "Model prices: 3 price changes, 2 need attention (Oct 10)". Only counts and
 * the date go in, nothing fetched. A price change counts once per model.
 */
export function renderTitle(decision, today) {
  const [, month, day] = today.split("-").map(Number);
  const changed = new Set(decision.changes.map(({ provider, model }) => `${provider}/${model}`)).size;
  const discovered = decision.newModels.reduce((sum, { ids }) => sum + ids.length, 0);
  const retirements = decision.retirements?.length ?? 0;
  const scheduled = decision.schedules?.length ?? 0;
  const parts = [
    changed && count(changed, "price change", "price changes"),
    scheduled && count(scheduled, "scheduled price change", "scheduled price changes"),
    retirements && count(retirements, "retirement date", "retirement dates"),
    discovered && count(discovered, "new model", "new models"),
    decision.attention.length && count(decision.attention.length, "needs attention", "need attention"),
  ].filter(Boolean);
  return `Model prices: ${parts.length ? parts.join(", ") : "no changes"} (${MONTHS[month - 1]} ${day})`;
}

export function renderReport(decision) {
  const ready = [];
  const sections = [];
  let attention = "";

  if (decision.changes.length > 0) {
    const rows = decision.changes.map(
      (change) =>
        `| ${code(`${change.provider}/${change.model}`)} | ${change.field} | ${change.from} → **${change.to}** | ${change.source} |`,
    );
    ready.push(`## ✅ Current price changes\n\n| Model | Field | Old → new | Source |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);
  }

  if (decision.newModels.length > 0) {
    const rows = decision.modelChoices?.length ? decision.modelChoices.map((choice) =>
      `| ${code(`${choice.provider}/${choice.model}`)} | **${choice.action === "add" ? "✅ Add" : choice.action === "skip" ? "⏭️ Skip" : "⚠️ Pending"}** | ${choice.kind ? escape(choice.kind) : "—"} | ${escape(choice.reason)} | ${escape(choice.origin === "ai" ? choice.reviewer : choice.origin === "manual" ? `@${choice.reviewer}` : "Catalog validation")} |`,
    ) : decision.newModels.flatMap(({ provider, ids }) =>
      ids.map((id) => `| ${code(provider)} | ${code(id)} |`),
    );
    ready.push(
      "## ✅ Newly discovered models\n\n" +
      "Merging applies the proposed **✅ Add** entries to the price list and saves each **⏭️ Skip** reason. AI chooses models; code reads and validates every price from the official source, and takes each model's kind from LiteLLM or Models.dev where they name one. **⚠️ Pending** models remain undecided.\n\n" +
      (decision.modelChoices?.length ? `| Model | Proposal | Kind | Reason | Reviewer |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}` : `| Provider | Model |\n| --- | --- |\n${rows.join("\n")}`) +
      "\n\nTo override a proposal, comment on this PR with one or more commands, one per line. The bot updates this same PR and preserves your choices on later runs:\n\n" +
      "```text\n/models add openai/gpt-6-luna\n/models add openai/gpt-image-3 image\n/models skip openai/gpt-4o-2024-05-13 Prefer current models\n```\n\nAn addition may name its kind (text, image, speech, transcription, embedding or realtime), which replaces the proposed one.",
    );
  }

  const rescheduled = new Set((decision.schedules ?? []).map(({ provider, model }) => `${provider}/${model}`));
  if (rescheduled.size > 0) {
    const announced = decision.upcoming.filter(({ provider, model }) => rescheduled.has(`${provider}/${model}`));
    const withdrawn = decision.schedules.filter((item) => item.to === undefined);
    ready.push(
      "## ✅ Scheduled price changes\n\n" +
        "Merging writes these to each model's `price_changes`: the rates that change, from 00:00 UTC on the day given. Billing keeps today's rates; this sync applies a change on its day.\n\n" +
        [
          announced.length > 0 ? upcomingTables(announced) : "",
          withdrawn.length > 0
            ? `No longer announced, so removed:\n\n${list(withdrawn, (item) => code(`${item.provider}/${item.model}`))}`
            : "",
        ].filter(Boolean).join("\n\n"),
    );
  }

  if (decision.retirements.length > 0) {
    const rows = decision.retirements.map(
      (item) =>
        `| ${code(`${item.provider}/${item.model}`)} | ${item.from === undefined ? "" : `${item.from} → `}**${item.to}** | ${item.source} |`,
    );
    ready.push(
      "## ✅ Retirement dates\n\n" +
        `| Model | Retires on | Source |\n| --- | --- | --- |\n${rows.join("\n")}`,
    );
  }

  if (decision.attention.length > 0) {
    attention =
      "## ❌ Needs your attention\n\n" +
      "These items need a manual fix. Merging this pull request does not resolve them.\n\n" +
      list(decision.attention, (item) => `${escape(item.text)} — ${code(item.key)}`) +
      "\n\nAn item that is expected can be acknowledged by adding its key, with a reason, to `scripts/models/acknowledged.json`.";
  }

  if (decision.sources.length > 0) {
    sections.push(
      details(
        "Sources",
        list(decision.sources, (item) => `${code(item.provider)}: ${escape(item.text)}${SOURCES[item.provider]?.official ? ` — [official pricing](${SOURCES[item.provider].official.url})` : ""}`),
      ),
    );
  }

  if (decision.noSource.length > 0) {
    sections.push(
      details(
        "Not covered by any source",
        list(decision.noSource, (item) => code(`${item.provider}/${item.model}`)),
      ),
    );
  }

  if (decision.deprecationNotes.length > 0) {
    sections.push(
      details(
        "Deprecation signals without a confirmed date",
        list(decision.deprecationNotes, (item) => `${code(`${item.provider}/${item.model}`)}: ${escape(item.text)}`),
      ),
    );
  }

  if ((decision.skippedModels ?? []).length > 0) {
    sections.push(
      details(
        "Models deliberately not added",
        list(decision.skippedModels, (item) => `${code(`${item.provider}/${item.model}`)}: ${escape(item.reason)}`),
      ),
    );
  }

  if (decision.acknowledged.length > 0) {
    sections.push(
      details(
        "Acknowledged",
        list(decision.acknowledged, (item) => `${escape(item.text)} — ${code(item.key)}: ${escape(item.reason)}`),
      ),
    );
  }

  const parts = ready.length
    ? ready
    : ["Nothing in the price list changes and no new models were found. No pull request is needed."];
  if (attention) parts.push(attention);
  if (sections.length > 0) parts.push("## ℹ️ Additional information\n\nFor information only. Nothing here needs action.\n\n" + sections.join("\n\n"));
  return `${REVIEW_MARKER}\n${parts.join("\n\n")}\n`;
}
