import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { USER_AGENT } from "../src/client.ts";

// The CLI under test runs with `./cli-agent.ts` preloaded. Its calls must still
// read as the CLI's, with the smoke checks named after it, and nothing else
// the process fetches may change.

const CLI_AGENT = pathToFileURL(resolve(fileURLToPath(import.meta.url), "../../src/cli-agent.ts")).href;

/** The `user-agent` a local server receives for each request the preloaded process makes. */
const SCRIPT = `
import { createServer } from "node:http";
const seen = [];
const server = createServer((request, response) => { seen.push(request.headers["user-agent"] ?? null); response.end(); });
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const url = "http://127.0.0.1:" + server.address().port + "/";
await fetch(url, { headers: { "user-agent": "agw/1.4.0", accept: "application/json" } });
await fetch(new Request(url, { headers: { "user-agent": "agw/1.4.0" } }));
await fetch(url, { headers: { "user-agent": "curl/8.7.1" } });
server.close();
console.log(JSON.stringify(seen));
`;

test("the CLI's own user-agent is followed by the smoke checks' name, and no other is touched", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", CLI_AGENT, "--input-type=module", "--eval", SCRIPT], {
    timeout: 20_000,
  });
  assert.deepEqual(JSON.parse(stdout), [`agw/1.4.0 ${USER_AGENT}`, `agw/1.4.0 ${USER_AGENT}`, "curl/8.7.1"]);
});
