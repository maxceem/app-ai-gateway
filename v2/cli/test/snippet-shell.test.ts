/**
 * The app snippet's curl commands (`src/admin/snippet-request.ts`), run in a
 * real shell against a local server: curl gets the credential on stdin and
 * sends it, and no credential is ever one of curl's arguments. Here, beside
 * the CLI's tests, because it needs a shell and curl, which the Worker's
 * tests cannot start. Skipped where curl is not installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlCommand, type SnippetRequest } from "../../src/admin/snippet-request.ts";

const realCurl = spawnSync("sh", ["-c", "command -v curl"]).stdout.toString().trim();
const skip = realCurl === "" ? "curl is not installed" : false;

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
 * Runs `command` with `sh -x` (tracing every command) in a folder holding
 * audio.mp3 and a `.curlrc` that turns on curl's own trace, behind a `curl`
 * that adds its arguments to a file, every call, and then runs the real one. Answers
 * what the server saw, the arguments curl got, and everything written:
 * output, the shell's trace and any curl trace.
 */
async function run(build: (base: string) => string): Promise<{ seen: Seen; exchanged: Seen | undefined; args: string; written: string; ran: string[] }> {
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
    const argsFile = join(dir, "args.txt");
    await writeFile(join(dir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$AGW_TEST_ARGS"\nexec ${realCurl} "$@"\n`);
    await chmod(join(dir, "curl"), 0o755);
    await writeFile(join(dir, "audio.mp3"), "ID3 not really audio");
    // What a .curlrc could do: trace every header to a file, and print it all.
    await writeFile(join(dir, ".curlrc"), `trace-ascii = "${join(dir, "trace.txt")}"\nverbose\n`);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let written = "";
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("sh", ["-x", "-c", build(base)], {
        cwd: dir,
        env: {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          HOME: dir,
          CURL_HOME: dir,
          XDG_CONFIG_HOME: dir,
          APP_AI_GATEWAY_KEY: APP_KEY,
          ISSUER_TOKEN,
          AGW_TEST_ARGS: argsFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (written += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (written += chunk.toString()));
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, written);
    assert.ok(seen, "the server saw no request");
    const trace = await readFile(join(dir, "trace.txt"), "utf8").catch(() => "");
    return { seen, exchanged, args: await readFile(argsFile, "utf8"), written: written + trace, ran: await readdir(dir) };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a JSON example sends the app key read from the environment, and curl never gets it as an argument", { skip }, async () => {
  const { seen, args, written } = await run((base) =>
    curlCommand(
      {
        method: "POST",
        url: `${base}/v2/apps/app_1/proxy/openai/v1/chat/completions`,
        headers: { "x-end-user-id": "user-123", "Content-Type": "application/json" },
        body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "it's $HOME" }] },
      } satisfies SnippetRequest,
      CREDENTIAL,
    ),
  );
  assert.equal(seen.headers.authorization, `Bearer ${APP_KEY}`);
  assert.equal(seen.headers["x-end-user-id"], "user-123");
  assert.deepEqual(JSON.parse(seen.body), { model: "gpt-4o-mini", messages: [{ role: "user", content: "it's $HOME" }] });
  assert.ok(!args.includes(APP_KEY), "curl got the app key as an argument");
  // --disable first, so no .curlrc is read.
  assert.match(args, /^--disable\n--config\n-\n/u);
  // Neither the shell's trace (set -x) nor a .curlrc trace shows it.
  assert.ok(!written.includes(APP_KEY), "the app key was written out");
  assert.match(written, /\+ set \+x/u);
});

test("app-controlled text stays data: a quote, $(...), backticks and a line break in a model run nothing", { skip }, async () => {
  for (const model of ["it's $(touch pwned)", "a`touch pwned`b", "line\nbreak $(touch pwned)"]) {
    const url = (base: string) => `${base}/v2/apps/app_1/proxy/gemini/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const json = await run((base) => curlCommand({ method: "POST", url: url(base), headers: { "x-end-user-id": model.replaceAll("\n", " "), "Content-Type": "application/json" }, body: { model } }, CREDENTIAL));
    // Sent as written, and nothing extra ran: no file appeared.
    assert.deepEqual(JSON.parse(json.seen.body), { model });
    assert.ok(json.seen.url.endsWith(`${encodeURIComponent(model)}:generateContent`), json.seen.url);
    assert.equal(json.ran.includes("pwned"), false, `something ran: ${json.ran.join(", ")}`);
    const form = await run((base) => curlCommand({ method: "POST", url: url(base), headers: {}, form: { model }, file: { field: "file", name: "audio.mp3" } }, CREDENTIAL));
    assert.ok(form.seen.body.includes(`name="model"\r\n\r\n${model.replaceAll("\n", "\r\n")}`) || form.seen.body.includes(model), "the form did not carry the model as written");
    assert.equal(form.ran.includes("pwned"), false, `something ran: ${form.ran.join(", ")}`);
  }
});

test("an upload sends the model as a text field beside the file", { skip }, async () => {
  const { seen, args, written } = await run((base) =>
    curlCommand(
      { method: "POST", url: `${base}/v1/speech-to-text`, headers: {}, form: { model_id: "@scribe_v2" }, file: { field: "file", name: "audio.mp3" } },
      CREDENTIAL,
    ),
  );
  assert.equal(seen.headers.authorization, `Bearer ${APP_KEY}`);
  // A value starting with @ is text, never a file read.
  assert.match(seen.body, /name="model_id"\r\n\r\n@scribe_v2\r\n/u);
  assert.match(seen.body, /name="file"; filename="audio\.mp3"/u);
  assert.ok(!args.includes(APP_KEY));
  assert.ok(!written.includes(APP_KEY));
});

test("an issuer app's example exchanges for a gateway token, sends it, and never prints or passes any credential", { skip }, async () => {
  const { seen, exchanged, args, written } = await run((base) =>
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
  for (const credential of [APP_KEY, ISSUER_TOKEN, GATEWAY_TOKEN]) {
    assert.ok(!args.includes(credential), "curl got a credential as an argument");
    assert.ok(!written.includes(credential), "a credential was printed or traced");
  }
  assert.match(written, /Exchanged the user's token for a gateway token\./u);
});
