// Publishes the handwritten documentation for machines: `llms.txt`,
// `llms-full.txt`, a markdown copy of every page beside its HTML URL, the
// agent manual at `/agents.md`, and the OpenAPI contract at `/openapi.json`.
// Everything is written into `public/`, so the deployed site stays static.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createOpenAPIDocument } from "../../src/contracts/openapi.ts";
import path from "node:path";

const root = new URL("../", import.meta.url);
const content = new URL("content/docs/", root);
const output = new URL("public/", root);
const siteUrl = (process.env.DOCS_SITE_URL ?? "https://docs.appaigateway.com").replace(/\/?$/, "/");

async function pages(dir, slugs = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "api") continue; // generated reference, not prose
      found.push(...(await pages(new URL(`${entry.name}/`, dir), [...slugs, entry.name])));
    } else if (entry.name.endsWith(".mdx")) {
      const slug = entry.name.replace(/\.mdx$/, "");
      const raw = await readFile(new URL(entry.name, dir), "utf8");
      found.push({ slugs: slug === "index" ? slugs : [...slugs, slug], ...parse(raw) });
    }
  }
  return found;
}

function parse(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = Object.fromEntries(
    (match?.[1] ?? "").split("\n").map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
  return { title: meta.title ?? "", description: meta.description ?? "", body: markdown(raw.slice(match?.[0].length ?? 0)) };
}

/** Turns the few MDX components the guides use into plain markdown. */
function markdown(body) {
  return body
    .replace(/<Callout(?:\s+type="[^"]*")?(?:\s+title="([^"]*)")?\s*>([\s\S]*?)<\/Callout>/g, (_, title, text) => {
      const lines = text.trim().split("\n").map((line) => `> ${line.trim()}`.trimEnd());
      return (title ? [`> **${title}**`, ">", ...lines] : lines).join("\n");
    })
    .replace(/<Cards>([\s\S]*?)<\/Cards>/g, (_, cards) =>
      [...cards.matchAll(/<Card\s+title="([^"]*)"\s+href="([^"]*)"\s+description="([^"]*)"\s*\/>/g)]
        .map(([, title, href, description]) => `- [${title}](${href}): ${description}`)
        .join("\n"),
    )
    .replace(/\]\((\/[^)]*)\)/g, (_, href) => `](${siteUrl}${href.replace(/^\//, "")})`);
}

async function order(dir, slugs = []) {
  let names;
  try {
    names = JSON.parse(await readFile(new URL("meta.json", dir), "utf8")).pages;
  } catch {
    names = (await readdir(dir)).map((name) => name.replace(/\.mdx$/, "")).sort();
  }
  const ordered = [];
  for (const name of names) {
    if (name === "api") continue;
    const entries = await readdir(dir);
    if (entries.includes(`${name}.mdx`)) ordered.push(name === "index" ? slugs : [...slugs, name]);
    else if (entries.includes(name)) ordered.push(...(await order(new URL(`${name}/`, dir), [...slugs, name])));
  }
  return ordered;
}

const all = await pages(content);
const bySlug = new Map(all.map((page) => [page.slugs.join("/"), page]));
const ordered = (await order(content)).map((slugs) => bySlug.get(slugs.join("/"))).filter(Boolean);

const url = (page) => `${siteUrl}${page.slugs.length ? `${page.slugs.join("/")}/` : ""}`;
const mdPath = (page) => `${page.slugs.length ? page.slugs.join("/") : "index"}.md`;

for (const page of all) {
  await rm(new URL(mdPath(page), output), { force: true });
}
for (const page of ordered) {
  const target = new URL(mdPath(page), output);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, `# ${page.title}\n\n${page.description}\n\n${page.body.trim()}\n`);
}

const manual = bySlug.get("automation/agent-manual");
await writeFile(new URL("agents.md", output), `# ${manual.title}\n\n${manual.description}\n\n${manual.body.trim()}\n`);

await writeFile(
  new URL("llms.txt", output),
  [
    "# App AI Gateway",
    "",
    "> A proxy that gives iOS apps and servers access to AI providers without shipping provider keys, with per-user limits and usage in one place.",
    "",
    "Every page below is also available as markdown by adding `.md` to its path. The agent manual is at " +
      `${siteUrl}agents.md and the OpenAPI contract at ${siteUrl}openapi.json.`,
    "",
    "## Documentation",
    "",
    ...ordered.map((page) => `- [${page.title}](${siteUrl}${mdPath(page)}): ${page.description}`),
    "",
    "## Full text",
    "",
    `- [llms-full.txt](${siteUrl}llms-full.txt): every page in one file`,
    "",
  ].join("\n"),
);

await writeFile(
  new URL("llms-full.txt", output),
  ordered.map((page) => `# ${page.title}\n\nSource: ${url(page)}\n\n${page.description}\n\n${page.body.trim()}\n`).join("\n\n---\n\n"),
);

await writeFile(new URL("openapi.json", output), JSON.stringify(createOpenAPIDocument({ includeHidden: false }), null, 2) + "\n");
console.log(`machine files: ${ordered.length} pages, agents.md, llms.txt, llms-full.txt, openapi.json`);
