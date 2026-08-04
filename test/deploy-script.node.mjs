import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMissingGeneratedSecrets,
  missingRequiredSecrets,
  parseSecretList,
} from "../scripts/deploy-lib.mjs";

const deterministicRandom = (length) => Buffer.alloc(length, 0xab);

test("parses Wrangler's JSON secret list", () => {
  const names = parseSecretList(
    JSON.stringify([
      { name: "ADMIN_TOKEN", type: "secret_text" },
      { name: "JWT_SECRET", type: "secret_text" },
    ]),
  );
  assert.deepEqual([...names], ["ADMIN_TOKEN", "JWT_SECRET"]);
});

test("reports missing user-provided deployment values", () => {
  assert.deepEqual(missingRequiredSecrets(new Set()), [
    "CF_AIG_GATEWAY_ID",
    "CF_AIG_TOKEN",
    "ADMIN_TOKEN",
  ]);
  assert.deepEqual(
    missingRequiredSecrets(new Set(["CF_AIG_GATEWAY_ID", "CF_AIG_TOKEN"])),
    ["ADMIN_TOKEN"],
  );
  assert.deepEqual(
    missingRequiredSecrets(new Set(["CF_AIG_GATEWAY_ID", "CF_AIG_TOKEN", "ADMIN_TOKEN"])),
    [],
  );
});

test("deploy button requests an existing gateway before its required token", () => {
  const projectRoot = new URL("..", import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL("package.json", projectRoot), "utf8"));
  const wranglerConfig = JSON.parse(readFileSync(new URL("wrangler.jsonc", projectRoot), "utf8"));
  const secretTemplate = readFileSync(new URL(".dev.vars.example", projectRoot), "utf8");

  assert.equal(wranglerConfig.vars?.CF_AIG_GATEWAY_ID, undefined);
  assert.deepEqual(Object.keys(packageJson.cloudflare.bindings), [
    "CF_AIG_GATEWAY_ID",
    "CF_AIG_TOKEN",
    "ADMIN_TOKEN",
  ]);
  assert.match(packageJson.cloudflare.bindings.CF_AIG_GATEWAY_ID.description, /Create a Cloudflare AI Gateway/u);
  assert.match(packageJson.cloudflare.bindings.CF_AIG_GATEWAY_ID.description, /does not create/u);
  assert.match(packageJson.cloudflare.bindings.CF_AIG_TOKEN.description, /Create authentication token/u);
  assert.match(secretTemplate, /^CF_AIG_GATEWAY_ID=$/mu);
  assert.match(secretTemplate, /^CF_AIG_TOKEN=$/mu);
  assert.ok(
    secretTemplate.indexOf("CF_AIG_GATEWAY_ID=") < secretTemplate.indexOf("CF_AIG_TOKEN="),
  );
});

test("generates the internal JWT secret once and leaves an existing value alone", () => {
  const first = createMissingGeneratedSecrets(new Set(), deterministicRandom);
  assert.equal(Buffer.from(first.JWT_SECRET, "base64url").byteLength, 48);

  const second = createMissingGeneratedSecrets(new Set(["JWT_SECRET"]), deterministicRandom);
  assert.deepEqual(second, {});
});

test("deployment uploads only the generated JWT secret and provisions D1 before migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-gateway-deploy-test-"));
  const fakeWrangler = join(directory, "wrangler.mjs");
  const callLog = join(directory, "calls.ndjson");
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const entry = { args };
if (args[0] === "secret" && args[1] === "bulk") entry.input = readFileSync(0, "utf8");
const previous = existsSync(process.env.FAKE_WRANGLER_LOG)
  ? readFileSync(process.env.FAKE_WRANGLER_LOG, "utf8")
  : "";
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(entry) + "\\n");
if (args[0] === "secret" && args[1] === "list") {
  console.log(JSON.stringify([
    { name: "CF_AIG_GATEWAY_ID" },
    { name: "ADMIN_TOKEN" },
    { name: "CF_AIG_TOKEN" }
  ]));
}
if (
  args[0] === "d1"
  && args[1] === "migrations"
  && !previous.includes('"d1","migrations"')
) {
  console.error(
    "Couldn't find an auto-provisioned D1 DB named 'app-ai-gateway-db' for binding 'DB'. "
    + "Run 'wrangler deploy' to provision it."
  );
  process.exit(1);
}
`,
    { mode: 0o700 },
  );
  chmodSync(fakeWrangler, 0o700);

  try {
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        AI_GATEWAY_WRANGLER_BIN: fakeWrangler,
        FAKE_WRANGLER_LOG: callLog,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /ADMIN_TOKEN=/u);

    const calls = readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["secret", "list", "--format", "json"],
        ["secret", "bulk"],
        ["d1", "migrations", "apply", "DB", "--remote"],
        ["deploy"],
        ["d1", "migrations", "apply", "DB", "--remote"],
      ],
    );

    const uploaded = JSON.parse(calls[1].input);
    assert.deepEqual(Object.keys(uploaded), ["JWT_SECRET"]);
    assert.equal(Buffer.from(uploaded.JWT_SECRET, "base64url").byteLength, 48);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
