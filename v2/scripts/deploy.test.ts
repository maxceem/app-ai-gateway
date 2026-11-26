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
  latestVersionIds,
  RELAY_CODE_UPDATE,
  sourceProblems,
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
const worker = config.includes("/vault/") ? "vault" : config.includes("/relay/") ? "relay" : "gateway";
if (args[0] === "deployments") {
  // FAKE_GATEWAY: "missing" (a first install), "offline" (the lookup fails), or a deployed RELAY_URL.
  const gateway = process.env.FAKE_GATEWAY || "missing";
  if (gateway === "missing") { console.error("This Worker does not exist on your account. [code: 10007]"); process.exit(1); }
  if (gateway === "offline") { console.error("fetch failed"); process.exit(1); }
  process.stdout.write(JSON.stringify([{ created_on: "2026-11-20T00:00:00Z", versions: [{ version_id: "v1" }] }]));
  process.exit(0);
}
if (args[0] === "versions" && args[1] === "view") {
  const gateway = process.env.FAKE_GATEWAY;
  if (gateway === "view-fails") { console.error("Authentication error [code: 10000]"); process.exit(1); }
  const bindings = gateway === "secrets-only" ? [] : [{ name: "RELAY_URL", type: "plain_text", text: gateway }];
  process.stdout.write(JSON.stringify({ resources: { bindings } }));
  process.exit(0);
}
if (args[0] === "deploy" && worker === "relay" && !process.env.FAKE_NO_RELAY_URL) console.log("  https://app-ai-gateway-v2-relay.team-1.workers.dev");
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}

/** A prebuilt folder: the gateway's bundle and the console. The vault and the relay come from the checkout. */
function prebuiltDir(dir: string): string {
  const out = join(dir, "prebuilt");
  mkdirSync(join(out, "worker"), { recursive: true });
  writeFileSync(join(out, "worker", "index.js"), "export default {};\n");
  mkdirSync(join(out, "console"), { recursive: true });
  return out;
}

function deploy(args: string[], bin: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_AI_GATEWAY_WRANGLER_BIN: bin, ...extra };
  return spawnSync(process.execPath, ["--experimental-strip-types", join(V2_DIR, "scripts", "deploy.ts"), ...args], {
    cwd: V2_DIR,
    encoding: "utf8",
    env,
  });
}

/** Copies of the three tracked configs as a temporary profile, removed after the test. */
function profileCopies(t: { after: (fn: () => void) => void }): { profile: string; edit: (worker: "main" | "vault" | "relay", change: (text: string) => string) => void } {
  const profile = `t${process.pid}${Math.random().toString(36).slice(2, 7)}`;
  const files = { main: "wrangler.jsonc", vault: "vault/wrangler.jsonc", relay: "relay/wrangler.jsonc" };
  const copies = Object.fromEntries(
    Object.entries(files).map(([worker, file]) => [worker, join(V2_DIR, file.replace("wrangler.jsonc", `wrangler.${profile}.jsonc`))]),
  ) as Record<keyof typeof files, string>;
  t.after(() => {
    for (const copy of Object.values(copies)) rmSync(copy, { force: true });
  });
  for (const [worker, file] of Object.entries(files)) cpSync(join(V2_DIR, file), copies[worker as keyof typeof files]);
  return { profile, edit: (worker, change) => writeFileSync(copies[worker], change(readFileSync(copies[worker], "utf8"))) };
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
  const deploys = fake.calls().filter((call) => !["deployments", "versions"].includes(call[0]!));
  assert.deepEqual(deploys.map(kind), ["deploy vault", "d1 migrations apply gateway", "deploy gateway", "deploy relay", "deploy gateway"]);
  // A first install: the gateway learns the relay's address once the relay exists.
  assert.ok(!deploys[2]!.includes("--var"));
  assert.ok(deploys[4]!.includes("RELAY_URL:https://app-ai-gateway-v2-relay.team-1.workers.dev"));
  // Every call is pinned to the config's top level: a CLOUDFLARE_ENV in the shell or a .env file is never used.
  for (const call of fake.calls()) {
    const at = call.indexOf("--env");
    assert.ok(at !== -1 && call[at + 1] === "", call.join(" "));
  }
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

test("the tracked relay config never turns the echo on", () => {
  assert.equal(tracked().relay.vars?.RELAY_ECHO, undefined);
});

test("a relay with no address to give the gateway is refused, unless RELAY_URL is set", () => {
  const { main, vault, relay } = tracked();
  const hidden = { ...relay, workers_dev: false };
  assert.match(deployProblems(main, vault, hidden).join("\n"), /set RELAY_URL/u);
  assert.deepEqual(deployProblems({ ...main, vars: { RELAY_URL: "https://relay.example.com" } }, vault, hidden), []);
  assert.deepEqual(deployProblems(main, vault, { ...hidden, routes: [{ pattern: "relay.example.com", custom_domain: true }] }), []);
});

test("a prebuilt deploy refuses a build command or base_dir in any of the three configs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const out = prebuiltDir(dir);
  for (const [worker, setting] of [["relay", '"build": { "command": "echo hi" },'], ["vault", '"base_dir": "..",'], ["main", '"build": { "command": "echo hi" },']] as const) {
    const copies = profileCopies(t);
    copies.edit(worker, (text) => text.replace('"main":', `${setting} "main":`));
    const run = deploy(["--profile", copies.profile, "--prebuilt", out, "--dry-run"], fake.bin);
    assert.equal(run.status, 2, worker);
    assert.match(run.stderr, /build command|base_dir/u);
  }
});

test("a deploy fails when the relay's address can't be found", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const run = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin, { FAKE_NO_RELAY_URL: "1" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /relay's address was not found/u);
});

test("the three Workers need three different names", () => {
  const { main, vault, relay } = tracked();
  assert.match(deployProblems(main, vault, { ...relay, name: main.name }).join("\n"), /each have their own Worker name/u);
  assert.match(deployProblems(main, { ...vault, name: relay.name }, relay).join("\n"), /each have their own Worker name/u);
});

test("the prebuilt build deletes and writes only inside v2/dist", () => {
  for (const out of [".", "src", "..", "dist", "/tmp/elsewhere"]) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", join(V2_DIR, "scripts", "build-prebuilt.ts"), out], { cwd: V2_DIR, encoding: "utf8" });
    assert.equal(run.status, 2, out);
    assert.match(run.stderr, /must be inside/u);
  }
  assert.ok(readdirSync(join(V2_DIR, "src")).length > 0);
});

test("a prebuilt deploy uploads the vault and the relay from the checkout, unbundled", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const run = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin);
  assert.equal(run.status, 0, run.stderr);
  const configOf = (call: string[]) => call[call.indexOf("--config") + 1];
  const deploys = fake.calls().filter((call) => call[0] === "deploy");
  assert.equal(configOf(deploys.find((call) => configOf(call)?.includes("/vault/"))!), join(V2_DIR, "vault", "wrangler.jsonc"));
  assert.equal(configOf(deploys.find((call) => configOf(call)?.includes("/relay/"))!), join(V2_DIR, "relay", "wrangler.jsonc"));
  const { vault, relay } = tracked();
  assert.match(deployProblems(tracked().main, { ...vault, no_bundle: false }, relay).join("\n"), /vault config must set no_bundle/u);
  assert.match(deployProblems(tracked().main, vault, { ...relay, no_bundle: undefined }).join("\n"), /relay config must set no_bundle/u);
});

test("a gateway whose RELAY_URL can't be read stops the deploy before the vault is touched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const run = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin, { FAKE_GATEWAY: "offline" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Could not read the gateway's current relay address; nothing was deployed/u);
  // Wrangler's own words show the real cause.
  assert.match(run.stderr, /fetch failed/u);
  assert.ok(fake.calls().every((call) => call[0] === "deployments"));
});

test("an existing gateway keeps its RELAY_URL; one only secrets:upload made counts as not deployed yet", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const relay = "https://app-ai-gateway-v2-relay.team-1.workers.dev";
  const kept = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin, { FAKE_GATEWAY: relay });
  assert.equal(kept.status, 0, kept.stderr);
  const gatewayDeploys = () => fake.calls().filter((call) => call[0] === "deploy" && kind(call) === "deploy gateway");
  // Deployed once, with the address it already had.
  assert.equal(gatewayDeploys().length, 1);
  assert.ok(gatewayDeploys()[0]!.includes(`RELAY_URL:${relay}`));
  const fresh = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin, { FAKE_GATEWAY: "secrets-only" });
  assert.equal(fresh.status, 0, fresh.stderr);
  // Like a first install: deployed without the address, then again once the relay's is known.
  assert.equal(gatewayDeploys().length, 3);
  assert.ok(gatewayDeploys()[2]!.includes(`RELAY_URL:${relay}`));
});

test("a failed read of the gateway's current version also stops the deploy before the vault", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agw-v2-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeWrangler(dir);
  const run = deploy(["--prebuilt", prebuiltDir(dir)], fake.bin, { FAKE_GATEWAY: "view-fails" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Could not read the gateway's current relay address; nothing was deployed/u);
  assert.match(run.stderr, /Authentication error/u);
  assert.ok(fake.calls().every((call) => call[0] === "deployments" || call[0] === "versions"));
});

test("the vault and the relay must run this checkout's vault/src and relay/src", () => {
  const { vault, relay } = tracked();
  const workers = (vaultMain: unknown, relayMain: unknown, dir = V2_DIR) => ({
    vault: { path: join(dir, "vault", "wrangler.test.jsonc"), config: { ...vault, main: vaultMain } },
    relay: { path: join(dir, "relay", "wrangler.test.jsonc"), config: { ...relay, main: relayMain } },
  });
  assert.deepEqual(sourceProblems(V2_DIR, workers("src/index.js", "src/index.js")), []);
  assert.match(sourceProblems(V2_DIR, workers("../relay/src/index.js", "src/index.js")).join("\n"), /vault config's main/u);
  assert.match(sourceProblems(V2_DIR, workers("src/index.js", "/tmp/other/index.js")).join("\n"), /relay config's main/u);
  // A config file somewhere else whose main still names this checkout's file passes; one beside a copy does not.
  assert.deepEqual(sourceProblems(V2_DIR, { ...workers("src/index.js", "src/index.js"), vault: { path: "/elsewhere/wrangler.jsonc", config: { ...vault, main: join(V2_DIR, "vault", "src", "index.js") } } }), []);
  assert.match(sourceProblems(V2_DIR, workers("src/index.js", "src/index.js", "/copy/v2")).join("\n"), /vault config's main/u);
});

