/**
 * The v2 console on a live deployment (step 2d): its pages load on the
 * console's host under `/v2`, with their script and styles, and are never
 * framed. A page with no file of its own, such as the sign-in page, gets the
 * console's document, which routes it in the browser.
 *
 *   V2_CONSOLE_URL=https://console.example.com \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Skipped without V2_CONSOLE_URL. It only reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const noConsole = consoleUrl === "" ? "V2_CONSOLE_URL is needed" : false;

const page = (path: string) =>
  fetch(new URL(path, consoleUrl), { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual" });

/** The console's document: its root element and the script it loads from `/v2/assets/`. */
async function assertConsoleDocument(response: Response): Promise<string> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/u);
  const script = /<script type="module" crossorigin src="(\/v2\/assets\/[^"]+\.js)"/u.exec(html)?.[1];
  assert.ok(script, "the document loads its script from /v2/assets/");
  return script;
}

test("the console loads on its host under /v2", { skip: noConsole }, async () => {
  const script = await assertConsoleDocument(await page("/v2/"));
  const bundle = await fetch(new URL(script, consoleUrl));
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type") ?? "", /javascript/u);
  // The sign-in page is part of the bundle the document loads.
  assert.match(await bundle.text(), /Sign in/u);
});

test("the sign-in, consent and device pages get the console's document", { skip: noConsole }, async () => {
  for (const path of ["/v2/login", "/v2/oauth/consent?id=x", "/v2/device"]) {
    await assertConsoleDocument(await page(path));
  }
});

test("the sign-in page's settings are served beside it", { skip: noConsole }, async () => {
  const response = await fetch(new URL("/v2/console/capabilities", consoleUrl));
  assert.equal(response.status, 200);
  const capabilities = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof capabilities.registrationOpen, "boolean");
  assert.equal(typeof capabilities.googleAuth, "boolean");
});

test("the price list is published beside the console, readable from anywhere", { skip: noConsole }, async () => {
  const response = await fetch(new URL("/v2/models.json", consoleUrl));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.ok(typeof (await response.json()) === "object");
});
