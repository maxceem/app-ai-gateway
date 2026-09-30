// The Markdown report that becomes the price pull request's body and the
// workflow's step summary. Empty sections are left out.
//
// Much of what it quotes came from a fetched page (a parser's reason, a model
// id a page lists), so every value goes through `escape` before it is placed
// in Markdown: nothing a page says can become a link, an image, HTML or a
// broken table.

/** Makes text inert in Markdown, inside or outside a table cell. */
export function escape(value) {
  return String(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]|]/gu, (char) => `\\${char}`);
}

function code(value) {
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

  if (decision.changes.length > 0) {
    const rows = decision.changes.map(
      (change) =>
        `| ${code(`${change.provider}/${change.model}`)} | ${change.field} | ${change.from} → **${change.to}** | ${change.source} |`,
    );
    sections.push(`## Price changes\n\n| Model | Field | Old → new | Source |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);
  }

  if (decision.attention.length > 0) {
    sections.push(
      "## Needs attention\n\n" +
        list(decision.attention, (item) => `${escape(item.text)} — ${code(item.key)}`) +
        "\n\nAn item that is expected can be acknowledged by adding its key, with a reason, to `scripts/prices/acknowledged.json`.",
    );
  }

  if (decision.upcoming.length > 0) {
    sections.push(
      "## Upcoming price changes\n\n" +
        list(
          decision.upcoming,
          (item) => `${code(`${item.provider}/${item.model}`)} ${item.field} becomes $${item.value} on ${item.date}`,
        ),
    );
  }

  if (decision.sources.length > 0) {
    sections.push(
      "## Sources\n\n" + list(decision.sources, (item) => `${code(item.provider)}: ${escape(item.text)}`),
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

  if (decision.newModels.length > 0) {
    sections.push(
      details(
        "New on official pages, not in the catalog",
        list(decision.newModels, (item) => `${code(item.provider)}: ${item.ids.map(code).join(", ")}`),
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
    "Checked every model in `src/usage/prices.json` against its provider's pricing, by `scripts/update-prices.mjs`.";
  return `${header}\n\n${sections.join("\n\n")}\n`;
}
