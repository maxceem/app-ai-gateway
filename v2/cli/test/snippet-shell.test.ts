/**
 * The app snippet's curl commands (`src/admin/snippet-request.ts`), run in a
 * real shell against a local server: the credential read from the
 * environment is sent, an issuer app's exchange works, and text from the
 * app's settings stays data. Here, beside the CLI's tests, because it needs a
 * shell and curl, which the Worker's tests cannot start. Skipped where curl is
 * not installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlCommand, type SnippetRequest } from "../../src/admin/snippet-request.ts";

const skip = spawnSync("sh", ["-c", "command -v curl"]).stdout.toString().trim() === "" ? "curl is not installed" : false;

const APP_KEY = "agw_app_dummy-key-for-the-shell-test-0123";
const ISSUER_TOKEN = "dummy.issuer.token-for-the-shell-test";
const GATEWAY_TOKEN = "dummy-gateway-token-from-the-exchange-0123";
const CREDENTIAL = { header: "Authorization", scheme: "Bearer", variable: "APP_AI_GATEWAY_KEY" } as const;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/**
 * Runs `command` with `sh` in a folder holding audio.mp3, with the app key
 * and the issuer token in the environment. Answers what the server saw, and
 * what the folder holds afterwards.
 */
async function run(build: (base: string) => string): Promise<{ seen: Seen; exchanged: Seen | undefined; ran: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "agw-snippet-"));
  let seen: Seen | undefined;
  let exchanged: Seen | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
    request.on("end", () => {
      const got = { method: request.method!, url: request.url!, headers: request.headers, body };
      // The issuer exchange answers a gateway token, as the gateway does.
      if (request.url!.endsWith("/auth/token")) {
        exchanged = got;
        response.end(JSON.stringify({ access_token: GATEWAY_TOKEN, expires_in: 3600 }));
        return;
      }
      seen = got;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(dir, "audio.mp3"), "ID3 not really audio");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let written = "";
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("sh", ["-c", build(base)], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: dir, APP_AI_GATEWAY_KEY: APP_KEY, ISSUER_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (written += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (written += chunk.toString()));
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, written);
    assert.ok(seen, "the server saw no request");
    return { seen, exchanged, ran: await readdir(dir) };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a JSON example sends the app key from the environment in its header", { skip }, async () => {
  const command = (base: string) =>
    curlCommand(
      {
        method: "POST",
        url: `${base}/v2/apps/app_1/proxy/openai/v1/chat/completions`,
        headers: { "x-end-user-id": "user-123", "Content-Type": "application/json" },
        body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "it's $HOME" }] },
      } satisfies SnippetRequest,
      CREDENTIAL,
    );
  // The form provider docs use.
  assert.match(command("http://127.0.0.1"), /-H "Authorization: Bearer \$APP_AI_GATEWAY_KEY"/u);
  const { seen } = await run(command);
  assert.equal(seen.headers.authorization, `Bearer ${APP_KEY}`);
  assert.equal(seen.headers["x-end-user-id"], "user-123");
  assert.deepEqual(JSON.parse(seen.body), { model: "gpt-4o-mini", messages: [{ role: "user", content: "it's $HOME" }] });
});

test("app-controlled text stays data: a quote, $(...) and backticks in a model run nothing", { skip }, async () => {
  // A line break never reaches a command: the gateway writes none for such a value.
  for (const model of ["it's $(touch pwned)", "a`touch pwned`b"]) {
    const url = (base: string) => `${base}/v2/apps/app_1/proxy/gemini/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const json = await run((base) => curlCommand({ method: "POST", url: url(base), headers: { "x-end-user-id": model, "Content-Type": "application/json" }, body: { model } }, CREDENTIAL));
    // Sent as written, and nothing extra ran: no file appeared.
    assert.deepEqual(JSON.parse(json.seen.body), { model });
    assert.ok(json.seen.url.endsWith(`${encodeURIComponent(model)}:generateContent`), json.seen.url);
    assert.equal(json.ran.includes("pwned"), false, `something ran: ${json.ran.join(", ")}`);
    const form = await run((base) => curlCommand({ method: "POST", url: url(base), headers: {}, form: { model }, file: { field: "file", name: "audio.mp3" } }, CREDENTIAL));
    assert.ok(form.seen.body.includes(`name="model"\r\n\r\n${model}\r\n`), "the form did not carry the model as written");
    assert.equal(form.ran.includes("pwned"), false, `something ran: ${form.ran.join(", ")}`);
  }
});

test("an upload sends the model as a text field beside the file", { skip }, async () => {
  const { seen } = await run((base) =>
    curlCommand(
      { method: "POST", url: `${base}/v1/speech-to-text`, headers: {}, form: { model_id: "@scribe_v2" }, file: { field: "file", name: "audio.mp3" } },
      CREDENTIAL,
    ),
  );
  assert.equal(seen.headers.authorization, `Bearer ${APP_KEY}`);
  // A value starting with @ is text, never a file read.
  assert.match(seen.body, /name="model_id"\r\n\r\n@scribe_v2\r\n/u);
  assert.match(seen.body, /name="file"; filename="audio\.mp3"/u);
});

test("an issuer app's example exchanges the key and the user's token for a gateway token, and sends it", { skip }, async () => {
  const { seen, exchanged } = await run((base) =>
    curlCommand(
      { method: "POST", url: `${base}/v2/apps/app_1/proxy/openai/v1/chat/completions`, headers: { "Content-Type": "application/json" }, body: { model: "m" } },
      { header: "Authorization", scheme: "Bearer", variable: "APP_AI_GATEWAY_TOKEN" },
      { url: `${base}/v2/apps/app_1/auth/token`, keyVariable: "APP_AI_GATEWAY_KEY", tokenVariable: "ISSUER_TOKEN", into: "APP_AI_GATEWAY_TOKEN" },
    ),
  );
  assert.ok(exchanged, "no exchange was made");
  assert.equal(exchanged.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(exchanged.body), { api_key: APP_KEY, issuer_token: ISSUER_TOKEN });
  // The token from the exchange is what the request sends.
  assert.equal(seen.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
});
