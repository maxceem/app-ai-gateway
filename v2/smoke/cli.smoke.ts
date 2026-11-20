/**
 * agw 2 against a live v2 deployment (step 2e), run from its sources with a
 * management key from the environment and state of its own:
 *
 * - `deployment connect` checks the key and stores no credential;
 * - a gateway command, built from the tool list, lists the apps;
 * - the built-in `app add`, `app update` and the gateway's `app remove`
 *   change a throwaway iOS app, which is removed again.
 *
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Skipped without both. Nothing is left behind.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const skip = consoleUrl === "" || managementKey === "" ? "V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false;
const bin = fileURLToPath(new URL("../cli/src/bin.ts", import.meta.url));

/** One `agw` run with `--json`, its document parsed. */
function agw(home: string, ...argv: string[]): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv, "--json"], {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        AGW_MANAGEMENT_KEY: managementKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? 1, json: JSON.parse(out) });
      } catch {
        reject(new Error(`agw ${argv.join(" ")} printed no JSON document`));
      }
    });
  });
}

test("agw 2 connects with a management key and manages an app", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  let created: string | undefined;
  try {
    const connected = await agw(home, "deployment", "connect", "--url", new URL(consoleUrl).origin);
    assert.equal(connected.code, 0, JSON.stringify(connected.json.error));
    assert.equal(connected.json.result.credential, "environment");

    const listed = await agw(home, "app", "list");
    assert.equal(listed.code, 0, JSON.stringify(listed.json.error));
    assert.ok(Array.isArray(listed.json.result.apps));

    const added = await agw(home, "app", "add", "--type", "ios", "--name", "agw smoke", "--team-id", "ABCDE12345", "--bundle-id", "com.example.agwsmoke");
    assert.equal(added.code, 0, JSON.stringify(added.json.error));
    created = added.json.result.app.id as string;
    assert.equal(added.json.result.key, null);

    const paused = await agw(home, "app", "update", created, "--status", "disabled");
    assert.equal(paused.code, 0, JSON.stringify(paused.json.error));
    assert.equal(paused.json.result.app.status, "disabled");
  } finally {
    if (created) {
      const removed = await agw(home, "app", "remove", created, "--yes");
      assert.equal(removed.code, 0, JSON.stringify(removed.json.error));
    }
    await rm(home, { recursive: true, force: true });
  }
});
