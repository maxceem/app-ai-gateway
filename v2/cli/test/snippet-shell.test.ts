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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlCommand, exchangeCommand, type SnippetRequest } from "../../src/admin/snippet-request.ts";

const realCurl = spawnSync("sh", ["-c", "command -v curl"]).stdout.toString().trim();
const skip = realCurl === "" ? "curl is not installed" : false;

const APP_KEY = "agw_app_dummy-key-for-the-shell-test-0123";
const ISSUER_TOKEN = "dummy.issuer.token-for-the-shell-test";
const CREDENTIAL = { header: "Authorization", scheme: "Bearer", variable: "APP_AI_GATEWAY_KEY" } as const;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/**
 * Runs `command` with `sh` in a folder holding audio.mp3, behind a `curl` that
 * writes its arguments to a file and then runs the real one. Answers what the
 * server saw and the arguments curl got.
 */
async function run(build: (base: string) => string): Promise<{ seen: Seen; args: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agw-snippet-"));
  let seen: Seen | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
    request.on("end", () => {
      seen = { method: request.method!, url: request.url!, headers: request.headers, body };
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const argsFile = join(dir, "args.txt");
    await writeFile(join(dir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$AGW_TEST_ARGS"\nexec ${realCurl} "$@"\n`);
    await chmod(join(dir, "curl"), 0o755);
    await writeFile(join(dir, "audio.mp3"), "ID3 not really audio");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("sh", ["-c", build(base)], {
        cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH ?? ""}`, APP_AI_GATEWAY_KEY: APP_KEY, ISSUER_TOKEN, AGW_TEST_ARGS: argsFile },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    assert.ok(seen, "the server saw no request");
    return { seen, args: await readFile(argsFile, "utf8") };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a JSON example sends the app key read from the environment, and curl never gets it as an argument", { skip }, async () => {
  const { seen, args } = await run((base) =>
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
  assert.match(args, /^--config\n-\n/u);
});

test("an upload sends the model as a text field beside the file", { skip }, async () => {
  const { seen, args } = await run((base) =>
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
});

test("the issuer exchange sends the key and the user's token in its body, neither as an argument", { skip }, async () => {
  const { seen, args } = await run((base) => exchangeCommand(`${base}/v2/apps/app_1/auth/token`, "APP_AI_GATEWAY_KEY", "ISSUER_TOKEN"));
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen.body), { api_key: APP_KEY, issuer_token: ISSUER_TOKEN });
  assert.ok(!args.includes(APP_KEY) && !args.includes(ISSUER_TOKEN), "curl got a credential as an argument");
});
