// The Markdown report that becomes the catalog pull request's body and the
// workflow's step summary. Current prices and new discoveries explain the PR trigger;
// everything else is additional information. Empty subsections are left out.
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

export function renderReport(decision) {
  const sections = [];
  const triggers = [];

  if (decision.changes.length > 0) {
    const rows = decision.changes.map(
      (change) =>
        `| ${code(`${change.provider}/${change.model}`)} | ${change.field} | ${change.from} → **${change.to}** | ${change.source} |`,
    );
    triggers.push(`### Current price changes\n\n| Model | Field | Old → new | Source |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);
  }

  if (decision.newModels.length > 0) {
    const rows = decision.modelChoices?.length ? decision.modelChoices.map((choice) =>
      `| ${code(`${choice.provider}/${choice.model}`)} | **${choice.action === "add" ? "✅ Add" : choice.action === "skip" ? "⏭️ Skip" : "⚠️ Pending"}** | ${escape(choice.reason)} | ${escape(choice.origin === "ai" ? choice.reviewer : choice.origin === "manual" ? `@${choice.reviewer}` : "Catalog validation")} |`,
    ) : decision.newModels.flatMap(({ provider, ids }) =>
      ids.map((id) => `| ${code(provider)} | ${code(id)} |`),
    );
    triggers.push(
      "### Newly discovered models\n\n" +
      "These discoveries trigger this PR, even without price changes. Merging applies the proposed **✅ Add** entries to the catalog and saves each **⏭️ Skip** reason. AI chooses models; code reads and validates every price from the official source. **⚠️ Pending** models remain undecided.\n\n" +
      (decision.modelChoices?.length ? `| Model | Proposal | Reason | Reviewer |\n| --- | --- | --- | --- |\n${rows.join("\n")}` : `| Provider | Model |\n| --- | --- |\n${rows.join("\n")}`) +
      "\n\nTo override a proposal, comment on this PR with one or more commands, one per line. The bot updates this same PR and preserves your choices on later runs:\n\n" +
      "```text\n/models add openai/gpt-6-luna\n/models skip openai/gpt-4o-2024-05-13 Prefer current models\n```",
    );
  }

  if (decision.retirements.length > 0) {
    const rows = decision.retirements.map(
      (item) =>
        `| ${code(`${item.provider}/${item.model}`)} | ${item.from === undefined ? "" : `${item.from} → `}**${item.to}** | ${item.source} |`,
    );
    sections.push(
      "### Retirement dates\n\n" +
        "When each provider stops serving the model. The entry stays in the catalog and stays priced.\n\n" +
        "These updates are included in the catalog only alongside current price changes.\n\n" +
        `| Model | Retires on | Source |\n| --- | --- | --- |\n${rows.join("\n")}`,
    );
  }

  if (decision.attention.length > 0) {
    sections.push(
      "### Needs attention\n\n" +
        "These items fail the workflow but do not trigger a pull request.\n\n" +
        list(decision.attention, (item) => `${escape(item.text)} — ${code(item.key)}`) +
        "\n\nAn item that is expected can be acknowledged by adding its key, with a reason, to `scripts/models/acknowledged.json`.",
    );
  }

  if (decision.upcoming.length > 0) {
    sections.push(
      "### Upcoming price changes\n\n" +
        "Advance notice only. Future rates are not stored or applied by this update.\n\n" +
        list(
          decision.upcoming,
          (item) => `${code(`${item.provider}/${item.model}`)} ${item.field} becomes $${item.value} on ${item.date}`,
        ),
    );
  }

  if (decision.retired.length > 0) {
    sections.push(
      "### Retired models gone from pricing pages\n\n" +
        list(decision.retired, (item) => `${code(`${item.provider}/${item.model}`)} ${escape(item.text)}`),
    );
  }

  if (decision.sources.length > 0) {
    sections.push(
      "### Sources\n\n" + list(decision.sources, (item) => `${code(item.provider)}: ${escape(item.text)}${SOURCES[item.provider]?.official ? ` — [official pricing](${SOURCES[item.provider].official.url})` : ""}`),
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

  const header =
    "Checked every model in `src/usage/models.json` against its provider's pricing and deprecation pages, by `scripts/update-models.mjs`.";
  const trigger = "## Changes that trigger a pull request\n\n" + (triggers.length
    ? "Current price changes and newly discovered models trigger a pull request.\n\n" + triggers.join("\n\n")
    : "No current price changes or newly discovered models. No pull request is needed.");
  const additional = sections.length > 0
    ? "\n\n## Additional information\n\n" +
      "The information below does not trigger a pull request.\n\n" +
      sections.join("\n\n")
    : "";
  return `${REVIEW_MARKER}\n${header}\n\n${trigger}${additional}\n`;
}
