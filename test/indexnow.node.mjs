import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedUrls, findKey, fingerprint, parseSitemap } from "../docs/scripts/indexnow.mjs";

const page = ({ title = "Page", description = "About it", head = "", nav = "Home", main = "<p>Hello</p>", script = "" } = {}) =>
  `<html><head><title>${title}</title><meta name="description" content="${description}">${head}` +
  `<link rel="stylesheet" href="/_astro/a.${script || "1"}.css"></head>` +
  `<body><nav>${nav}</nav><main data-cid="${script}">${main}<script>${script}</script></main></body></html>`;

test("a rebuild that only changes assets, scripts or navigation keeps the fingerprint", () => {
  const before = fingerprint(page());
  assert.equal(fingerprint(page({ script: "build-2" })), before);
  assert.equal(fingerprint(page({ nav: "Home Learn" })), before);
});

test("changes a reader or a search engine sees change the fingerprint", () => {
  const before = fingerprint(page());
  assert.notEqual(fingerprint(page({ title: "New title" })), before);
  assert.notEqual(fingerprint(page({ description: "Shorter" })), before);
  assert.notEqual(fingerprint(page({ head: '<meta name="robots" content="noindex">' })), before);
  assert.notEqual(fingerprint(page({ head: '<link rel="canonical" href="https://x.test/b/">' })), before);
  assert.notEqual(fingerprint(page({ main: "<p>Hello again</p>" })), before);
  assert.notEqual(fingerprint(page({ main: '<p><a href="/a/">Hello</a></p>' })), fingerprint(page({ main: '<p><a href="/b/">Hello</a></p>' })));
  assert.notEqual(fingerprint(page({ main: '<img src="/a.webp">' })), fingerprint(page({ main: '<img src="/b.webp">' })));
});

test("a page without <main> is fingerprinted by its <article>", () => {
  const docs = (nav, text) => `<body><aside>${nav}</aside><article id="nd-page">${text}</article></body>`;
  assert.equal(fingerprint(docs("A", "Text")), fingerprint(docs("A B", "Text")));
  assert.notEqual(fingerprint(docs("A", "Text")), fingerprint(docs("A", "Other text")));
});

test("sitemaps and sitemap indexes list their URLs", () => {
  assert.deepEqual(
    parseSitemap('<urlset><url><loc>https://x.test/</loc><lastmod>2026</lastmod></url><url><loc>https://x.test/a?b=1&amp;c=2</loc></url></urlset>'),
    { pages: ["https://x.test/", "https://x.test/a?b=1&c=2"], sitemaps: [] },
  );
  assert.deepEqual(parseSitemap("<sitemapindex><sitemap><loc>https://x.test/sitemap-0.xml</loc></sitemap></sitemapindex>"), {
    pages: [],
    sitemaps: ["https://x.test/sitemap-0.xml"],
  });
});

test("added, changed, removed and unreadable pages are submitted; unchanged ones are not", () => {
  const before = { "/same": "1", "/changed": "1", "/removed": "1", "/unreadable": null };
  const after = { "/same": "1", "/changed": "2", "/added": "1", "/unreadable": "1" };
  assert.deepEqual(changedUrls(before, after), ["/added", "/changed", "/removed", "/unreadable"]);
});

test("the key is the one file named after its own content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
  const key = "0123456789abcdef0123456789abcdef";
  writeFileSync(join(dir, "robots.txt"), "User-agent: *");
  await assert.rejects(findKey(dir), /found 0/);
  writeFileSync(join(dir, `${key}.txt`), `${key}\n`);
  assert.equal(await findKey(dir), key);
  writeFileSync(join(dir, "fedcba9876543210fedcba9876543210.txt"), "something else");
  assert.equal(await findKey(dir), key);
});

test("the site's own key file is deployed with it", async () => {
  assert.match(await findKey(new URL("../docs/public/", import.meta.url).pathname), /^[a-f0-9]{32}$/);
});
