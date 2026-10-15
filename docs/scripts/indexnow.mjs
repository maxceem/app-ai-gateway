// Tells search engines that support IndexNow (Bing, Yandex, Naver, Seznam;
// ChatGPT search draws on Bing) which pages a deploy added, changed or
// removed, so they recrawl those pages now instead of on their next visit.
//
//   node docs/scripts/indexnow.mjs snapshot <site>              before deploying
//   node docs/scripts/indexnow.mjs submit <site> <dir> [--all] [--dry-run]  after
//
// `snapshot` fingerprints every page in the live sitemap and keeps the result
// in the system temp directory. `submit` fingerprints the built pages in <dir>
// the same way and submits every URL whose fingerprint differs, including
// pages that were added or removed; `--all` submits every page in the sitemap.
// A fingerprint covers the title, description, canonical URL and the main
// content with its link targets, so rebuilt assets and navigation alone don't
// count as a change. The key is the `<key>.txt` file in <dir>, which is
// deployed with the site so search engines can verify it.
//
// Neither command fails a deploy: problems are printed as warnings.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.indexnow.org/indexnow";

/** A short hash of what a reader or a search engine sees on the page. */
export function fingerprint(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const tags = [...html.matchAll(/<(?:meta|link)\b[^>]*>/gi)].map((m) => m[0]);
  const head = tags
    .filter((tag) => /\b(?:name="(?:description|robots)"|rel="canonical")/i.test(tag))
    .map((tag) => tag.match(/\b(?:content|href)="([^"]*)"/i)?.[1] ?? "")
    .sort();
  const text = mainContent(html)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:a|img)\b[^>]*?\b(?:href|src)="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(JSON.stringify([title.trim(), head, text])).digest("hex").slice(0, 16);
}

/** The page's own content: its <main>, else its <article>, else its <body>. */
function mainContent(html) {
  for (const tag of ["main", "article", "body"]) {
    const start = html.search(new RegExp(`<${tag}\\b`, "i"));
    const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (start !== -1 && end > start) return html.slice(start, end);
  }
  return html;
}

/** Page and nested sitemap URLs listed in a sitemap or sitemap index. */
export function parseSitemap(xml) {
  const locs = (block) => [...xml.matchAll(new RegExp(`<${block}>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>`, "g"))].map((m) => decode(m[1]));
  return { pages: locs("url"), sitemaps: locs("sitemap") };
}

function decode(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** URLs whose fingerprint differs, including pages only one side has. */
export function changedUrls(before, after) {
  const urls = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...urls].filter((url) => before[url] === undefined || before[url] !== after[url]).sort();
}

/** The IndexNow key: the one `<key>.txt` file in <dir> that contains its own name. */
export async function findKey(dir) {
  const keys = [];
  for (const name of await readdir(dir)) {
    const key = name.match(/^([a-f0-9]{32})\.txt$/)?.[1];
    if (key && (await readFile(join(dir, name), "utf8")).trim() === key) keys.push(key);
  }
  if (keys.length !== 1) throw new Error(`expected one <key>.txt file in ${dir}, found ${keys.length}`);
  return keys[0];
}

/** Every page URL in a site's sitemaps, read through `read(url)`. */
async function sitemapPages(site, read) {
  const robots = (await read(new URL("/robots.txt", site).href)) ?? "";
  const queue = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (queue.length === 0) queue.push(new URL("/sitemap.xml", site).href);
  const pages = new Set();
  for (let i = 0; i < queue.length; i++) {
    const xml = await read(queue[i]);
    if (xml === undefined) throw new Error(`cannot read the sitemap ${queue[i]}`);
    const found = parseSitemap(xml);
    found.pages.forEach((page) => pages.add(page));
    queue.push(...found.sitemaps.filter((url) => !queue.includes(url)));
  }
  return [...pages];
}

/** Fingerprints for the given URLs, reading up to eight pages at a time. */
async function fingerprints(urls, read) {
  const result = {};
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      const html = await read(url);
      result[url] = html === undefined ? null : fingerprint(html);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return result;
}

async function readLive(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
  return response.ok ? response.text() : undefined;
}

/** Reads a site URL from the built directory instead of the network. */
function readBuilt(site, dir) {
  const origin = new URL(site).origin;
  return async (url) => {
    const { origin: urlOrigin, pathname } = new URL(url);
    if (urlOrigin !== origin) return undefined;
    const path = decodeURIComponent(pathname);
    for (const file of [path.endsWith("/") ? `${path}index.html` : path, `${path}.html`, `${path}/index.html`]) {
      const full = join(dir, file);
      if (existsSync(full)) return readFile(full, "utf8");
    }
    return undefined;
  };
}

const snapshotFile = (site) => join(tmpdir(), `indexnow-${new URL(site).host}.json`);

async function snapshot(site) {
  const pages = await sitemapPages(site, readLive);
  await writeFile(snapshotFile(site), JSON.stringify(await fingerprints(pages, readLive)));
  console.log(`IndexNow: fingerprinted ${pages.length} live pages of ${new URL(site).host}.`);
}

async function submit(site, dir, { all, dryRun }) {
  const key = await findKey(dir);
  const read = readBuilt(site, dir);
  const after = await fingerprints(await sitemapPages(site, read), read);
  let urls;
  if (all) {
    urls = Object.keys(after).sort();
  } else {
    if (!existsSync(snapshotFile(site))) {
      console.warn(`IndexNow: no snapshot of ${site}; run \`snapshot\` before deploying, or pass --all. Nothing submitted.`);
      return;
    }
    urls = changedUrls(JSON.parse(await readFile(snapshotFile(site), "utf8")), after);
  }
  if (urls.length === 0) {
    console.log("IndexNow: no page changed, nothing to submit.");
  } else if (dryRun) {
    console.log(`IndexNow: would submit ${urls.length} URLs:\n  ${urls.join("\n  ")}`);
    return;
  } else {
    const host = new URL(site).host;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: new URL(`/${key}.txt`, site).href, urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`IndexNow: submission refused with ${response.status} ${(await response.text()).slice(0, 300)}`);
      return;
    }
    console.log(`IndexNow: submitted ${urls.length} URLs (${response.status}):\n  ${urls.join("\n  ")}`);
  }
  await rm(snapshotFile(site), { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, site, dir] = process.argv.slice(2);
  const flags = { all: process.argv.includes("--all"), dryRun: process.argv.includes("--dry-run") };
  if (!site || (command === "submit" ? !dir : command !== "snapshot")) {
    console.error("usage: indexnow.mjs snapshot <site> | submit <site> <dir> [--all] [--dry-run]");
    process.exit(2);
  }
  try {
    await (command === "snapshot" ? snapshot(site) : submit(site, dir, flags));
  } catch (error) {
    console.warn(`IndexNow: skipped, ${error instanceof Error ? error.message : error}`);
  }
}
