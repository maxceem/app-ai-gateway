/**
 * The v2 deploy (`deploy.ts`, `deploy-lib.ts`) and the relay's config (plan
 * step 9a). The deploy runs against a stand-in for Wrangler that records its
 * calls, so no account is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployedVar,
  deployProblems,
  hashDifferences,
  latestVersionIds,
  RELAY_CODE_UPDATE,
  relayUrlFromConfig,
  relayUrlFromDeployOutput,
  type WorkerConfig,
} from "./deploy-lib.ts";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const { experimental_readRawConfig } = await import("wrangler");
const read = (path: string): WorkerConfig => (experimental_readRawConfig({ config: path }) as { rawConfig: WorkerConfig }).rawConfig;
const tracked = () => ({
  main: read(join(V2_DIR, "wrangler.jsonc")),
  vault: read(join(V2_DIR, "vault", "wrangler.jsonc")),
  relay: read(join(V2_DIR, "relay", "wrangler.jsonc")),
});

test("the tracked configs fit together, and the relay keeps open sessions through a deploy", () => {
  const { main, vault, relay } = tracked();
  assert.deepEqual(deployProblems(main, vault, relay), []);
  assert.deepEqual(relay.durable_objects?.code_update_strategy, RELAY_CODE_UPDATE);
  assert.equal(RELAY_CODE_UPDATE.max_delay, 2400);
});

test("a relay config without its code-update setting is refused", () => {
  const { main, vault, relay } = tracked();
  const without = { ...relay, durable_objects: { ...relay.durable_objects, code_update_strategy: undefined } };
  assert.match(deployProblems(main, vault, without).join("\n"), /code_update_strategy/u);
  const shorter = { ...relay, durable_objects: { code_update_strategy: { mode: "deferred", max_delay: 300 } } };
  assert.match(deployProblems(main, vault, shorter).join("\n"), /code_update_strategy/u);
});

test("bindings must name the Workers deployed with them", () => {
  const { main, vault, relay } = tracked();
  assert.match(deployProblems(main, { ...vault, name: "other-vault" }, relay).join("\n"), /VAULT binding/u);
  assert.match(deployProblems({ ...main, name: "other-gateway" }, vault, relay).join("\n"), /MAIN binding/u);
});

test("a kms vault holds no local setting, and only the vault holds vault settings", () => {
  const { main, vault, relay } = tracked();
  const kms = { ...vault, vars: { SECRET_VAULT_MODE: "kms", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1" } };
  assert.match(deployProblems(main, kms, relay).join("\n"), /SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION/u);
  assert.deepEqual(deployProblems(main, { ...vault, vars: { SECRET_VAULT_MODE: "kms" } }, relay), []);
  assert.match(deployProblems({ ...main, vars: { SECRET_VAULT_MODE: "local" } }, vault, relay).join("\n"), /from the gateway config/u);
  assert.match(deployProblems(main, vault, { ...relay, vars: { SECRET_VAULT_MODE: "local" } }).join("\n"), /from the relay config/u);
});

test("the relay's address comes from its custom domain or from Wrangler's output", () => {
  assert.equal(relayUrlFromConfig({ routes: [{ pattern: "relay.example.com", custom_domain: true }] }), "https://relay.example.com");
  assert.equal(relayUrlFromConfig({ routes: [{ pattern: "example.com/relay/*", zone_name: "example.com" }] }), undefined);
  const output = "Uploaded agw-test-v2-relay (1.2 sec)\nDeployed agw-test-v2-relay triggers\n  https://agw-test-v2-relay.team-1.workers.dev\nCurrent Version ID: x";
  assert.equal(relayUrlFromDeployOutput(output, "agw-test-v2-relay"), "https://agw-test-v2-relay.team-1.workers.dev");
  assert.equal(relayUrlFromDeployOutput("https://agw-test-v2.team-1.workers.dev", "agw-test-v2-relay"), undefined);
});

test("the gateway's current RELAY_URL is read from its newest deployment", () => {
  const list = JSON.stringify([
    { created_on: "2026-11-01T00:00:00Z", versions: [{ version_id: "old" }] },
    { created_on: "2026-11-20T00:00:00Z", versions: [{ version_id: "new" }] },
  ]);
  assert.deepEqual(latestVersionIds(list), ["new"]);
  assert.deepEqual(latestVersionIds("[]"), []);
  const version = JSON.stringify({ resources: { bindings: [{ name: "RELAY_URL", type: "plain_text", text: "https://r.example.com" }] } });
  assert.equal(deployedVar(version, "RELAY_URL"), "https://r.example.com");
  assert.equal(deployedVar(JSON.stringify({ resources: { bindings: [] } }), "RELAY_URL"), undefined);
});

test("file hashes are compared both ways", () => {
  const expected = new Map([["a.js", "1"], ["b.js", "2"]]);
  assert.deepEqual(hashDifferences(expected, new Map(expected)), []);
  assert.deepEqual(hashDifferences(expected, new Map([["a.js", "9"], ["c.js", "3"]])), ["changed a.js", "missing b.js", "extra c.js"]);
});

test("the relay imports nothing from the gateway (plan section 5.2)", () => {
  const dir = join(V2_DIR, "relay", "src");
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const [, from] of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gmu)) {
      assert.ok(from!.startsWith("./") || from!.startsWith("cloudflare:"), `${file} imports ${from}`);
    }
  }
});

/** A stand-in for Wrangler: logs each call, prints a workers.dev address for the relay, and knows no deployment. */
function fakeWrangler(dir: string): { bin: string; calls: () => string[][] } {
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "wrangler");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const config = args[args.indexOf("--config") + 1] || "";
if (args[0] === "deployments") { process.stdout.write("[]"); process.exit(0); }
if (args[0] === "deploy" && config.includes("/relay/")) console.log("  https://app-ai-gateway-v2-relay.team-1.workers.dev");
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}

/** A prebuilt folder with the vault's and the relay's files as git has them. */
function prebuiltDir(dir: string): string {
  const out = join(dir, "prebuilt");
  mkdirSync(join(out, "worker"), { recursive: true });
  writeFileSync(join(out, "worker", "index.js"), "export default {};\n");
  mkdirSync(join(out, "console"), { recursive: true });
  for (const name of ["vault", "relay"]) {
    const files = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", `v2/${name}/src`], { cwd: dirname(V2_DIR), encoding: "utf8" }).stdout.trim().split("\n");
    for (const file of files) {
      const target = join(out, name, "src", file.slice(`v2/${name}/src/`.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, spawnSync("git", ["show", `HEAD:${file}`], { cwd: dirname(V2_DIR) }).stdout);
    }
  }
  return out;
}

function deploy(args: string[], bin: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", join(V2_DIR, "scripts", "deploy.ts"), ...args], {
    cwd: V2_DIR,
    encoding: "utf8",
    env: { ...process.env, APP_AI_GATEWAY_WRANGLER_BIN: bin },
  });
}

const kind = (call: string[]): string => {
  const config = call[call.indexOf("--config") + 1] ?? "";
  return `${call.slice(0, call[0] === "d1" ? 3 : 1).join(" ")} ${config.includes("/vault/") ? "vault" : config.includes("/relay/") ? "relay" : "gateway"}`;
};

test("a deploy goes vault, migrations, gateway, relay, and gives the gateway the relay's address", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  // Prebuilt, so the test doesn't build the console.
  const run = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin);
  assert.equal(run.status, 0, run.stderr);
  const deploys = fake.calls().filter((call) => call[0] !== "deployments" && call[0] !== "versions");
  assert.deepEqual(deploys.map(kind), ["deploy vault", "d1 migrations apply gateway", "deploy gateway", "deploy relay", "deploy gateway"]);
  // A first install: the gateway learns the relay's address once the relay exists.
  assert.ok(!deploys[2]!.includes("--var"));
  assert.ok(deploys[4]!.includes("RELAY_URL:https://app-ai-gateway-v2-relay.team-1.workers.dev"));
});

test("a prebuilt deploy refuses vault or relay files that differ from git", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const out = prebuiltDir(dir);
  writeFileSync(join(out, "relay", "src", "index.js"), "export default {};\n");
  const run = deploy(["--prebuilt", out, "--dry-run"], fake.bin);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /prebuilt relay files are not the ones in git/u);
  assert.match(run.stderr, /changed index\.js/u);
  // Nothing reached Wrangler's deploy.
  assert.ok(!readdirSync(dir).includes("calls.jsonl") || fake.calls().every((call) => call[0] !== "deploy"));
});

test("a profile whose relay drops its code-update setting deploys nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  const profile = `t${process.pid}`;
  const files = ["wrangler.jsonc", "vault/wrangler.jsonc", "relay/wrangler.jsonc"].map((file) => [join(V2_DIR, file), join(V2_DIR, file.replace("wrangler.jsonc", `wrangler.${profile}.jsonc`))] as const);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [, copy] of files) rmSync(copy, { force: true });
  });
  for (const [original, copy] of files) cpSync(original, copy);
  const relayCopy = files[2]![1];
  writeFileSync(relayCopy, readFileSync(relayCopy, "utf8").replace(/"code_update_strategy"[^}]*\},?/u, ""));
  const fake = fakeWrangler(dir);
  const run = deploy(["--profile", profile, "--dry-run"], fake.bin);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Nothing was deployed/u);
  assert.match(run.stderr, /code_update_strategy/u);
});
