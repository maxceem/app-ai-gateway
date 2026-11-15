import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the actual checkout/default-Node entry and adapter; only Cloudflare's
// process/API boundary is fake. SQLite executes the real control migrations.
/**
 * A checkout whose Cloudflare is fake: the real deploy entry and adapter run,
 * and SQLite executes the real control migrations. `run(...args)` deploys.
 */
function checkoutFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "seamless-adapter-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const folder of ["scripts", "cli/src", "cli/scripts", "src/realtime", "migrations"]) {
    cpSync(join(root, folder), join(directory, folder), { recursive: true });
  }
  cpSync(join(root, "package.json"), join(directory, "package.json"));
  cpSync(join(root, "cli/package.json"), join(directory, "cli/package.json"));
  cpSync(join(root, "wrangler.realtime.jsonc"), join(directory, "wrangler.realtime.jsonc"));
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify({
    name: "selected-primary",
    main: "src/index.ts",
    account_id: "selected-account",
    d1_databases: [{ binding: "DB", database_id: "selected-db", migrations_dir: "migrations" }],
    vars: { SECRET_VAULT_MODE: "local", REALTIME_RELEASES: "seamless" },
  }));
  writeFileSync(
    join(directory, ".dev.vars"),
    "SECRET_VAULT_LOCAL_KEK_V1=fixture-not-a-real-key\nDEPLOYMENT_ID=selected-installation\n",
  );
  const statePath = join(directory, "state.json");
  writeFileSync(statePath, JSON.stringify({ workers: {}, secrets: [], failSecret: true, calls: [] }));
  const fake = join(directory, "fake-wrangler.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath));
const path = args[args.indexOf("--config") + 1];
// A generated config opens with comment lines, as Wrangler's own reader allows.
const readConfig = file => JSON.parse(readFileSync(file, "utf8").replace(/^\\s*\\/\\/.*$/gmu, ""));
const configuration = readConfig(args.includes("--config") ? path : "wrangler.jsonc");
state.calls.push({ args, config: configuration, ciName: process.env.WRANGLER_CI_OVERRIDE_NAME });
function save() {
  writeFileSync(statePath, JSON.stringify(state));
}
save();
if (args[0] === "auth") console.log(JSON.stringify({ type: "api_token", token: "fixture" }));
if (args[0] === "deployments") {
  if (!state.workers["selected-primary"]) {
    console.error("Worker missing [code: 10090]");
    process.exit(1);
  }
  console.log(JSON.stringify([
    { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "main-version", percentage: 100 }] },
  ]));
}
if (args[0] === "versions") {
  console.log(JSON.stringify({ resources: { bindings: state.workers["selected-primary"].bindings } }));
}
if (args[0] === "deploy") {
  if (args.includes("--dry-run")) {
    const output = args[args.indexOf("--outdir") + 1];
    mkdirSync(output, { recursive: true });
    const bundle = configuration.name === "app-ai-gateway-realtime-local" ? "worker.js" : "index.js";
    writeFileSync(join(output, bundle), "bundle");
  } else {
    state.workers[configuration.name] = {
      bindings: Object.entries(configuration.vars ?? {})
        .map(([name, text]) => ({ name, text, type: "plain_text" })),
    };
    save();
  }
}
if (args[0] === "secret") {
  if (args[1] === "list") console.log(JSON.stringify(state.secrets.map(name => ({ name }))));
  if (args[1] === "bulk") {
    state.secrets = [...new Set([...state.secrets, ...Object.keys(JSON.parse(readFileSync(0, "utf8")))])];
    const fail = state.failSecret;
    state.failSecret = false;
    save();
    if (fail) {
      console.error("Interrupted after secret creation");
      process.exit(1);
    }
  }
}
if (args[0] === "d1") {
  const db = new DatabaseSync(process.env.FAKE_DB);
  if (args[1] === "migrations") {
    // Applied once, as Wrangler tracks applied migrations.
    if (!state.migrated) db.exec(readFileSync("migrations/0017_realtime_releases.sql", "utf8"));
    state.migrated = true;
    save();
  }
  else {
    const sql = args[args.indexOf("--command") + 1];
    let results = [];
    if (sql.includes(";") || sql.startsWith("CREATE")) db.exec(sql);
    else results = db.prepare(sql).all();
    console.log(JSON.stringify([{ success: true, results }]));
  }
  db.close();
}
`, { mode: 0o700 });
  // The RT name is read from the real checked-in config rather than duplicated.
  const realtimeName = JSON.parse(
    readFileSync(join(root, "wrangler.realtime.jsonc"), "utf8").replace(/^\s*\/\/.*$/gmu, ""),
  ).name;
  writeFileSync(
    fake,
    readFileSync(fake, "utf8").replace("app-ai-gateway-realtime-local", realtimeName),
    { mode: 0o700 },
  );
  writeFileSync(join(directory, "run.mjs"), `
import { readFileSync } from "node:fs";
globalThis.fetch = async url => {
  const state = JSON.parse(readFileSync(process.env.FAKE_STATE));
  const u = new URL(url);
  if (u.hostname === "api.cloudflare.com") {
    if (u.pathname.endsWith("/subdomain")) {
      return Response.json({ success: true, result: { subdomain: "fixture" } });
    }
    const worker = u.pathname.split("/").at(-2);
    return state.workers[worker]
      ? Response.json({ success: true, result: state.workers[worker] })
      : Response.json(
        { success: false, errors: [{ code: 10090, message: "Missing Worker" }] },
        { status: 404 },
      );
  }
  const primary = state.workers["selected-primary"];
  const text = name => primary?.bindings.find(b => b.name === name)?.text;
  if (u.pathname.endsWith("/capabilities")) {
    return Response.json({
      deployment: { id: text("DEPLOYMENT_ID") },
      serverVersion: JSON.parse(readFileSync("package.json")).version,
    });
  }
  const realtime = state.workers[u.hostname.split(".")[0]];
  return Response.json(realtime && u.hostname.startsWith("agw-rt-")
    ? {
      ok: true,
      releaseId: realtime.bindings.find(b => b.name === "REALTIME_RELEASE_ID").text,
      backendContract: 1,
    }
    : { ok: true, buildId: text("GATEWAY_BUILD_ID"), ready: true, backendContract: 1 });
};
await import("./scripts/deploy.mjs");
`);
  const run = (...args) => spawnSync(process.execPath, ["run.mjs", ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      APP_AI_GATEWAY_WRANGLER_BIN: fake,
      FAKE_STATE: statePath,
      FAKE_DB: join(directory, "db.sqlite"),
      WRANGLER_CI_OVERRIDE_NAME: "selected-primary",
      DEPLOYMENT_ID: "",
    },
  });
  return { directory, statePath, run };
}

test("checkout adapter preserves selected primary/D1 and retries after first secret creation", t => {
  const { statePath, run } = checkoutFixture(t);

  const first = run();
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /Interrupted after secret creation/);
  const interrupted = JSON.parse(readFileSync(statePath));
  assert.equal(
    interrupted.workers["selected-primary"].bindings.find(b => b.name === "DEPLOYMENT_ID").text,
    "selected-installation",
  );
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const completed = JSON.parse(readFileSync(statePath));
  const primary = completed.calls.filter(call =>
    call.args[0] === "deploy"
    && !call.args.includes("--dry-run")
    && call.config.name === "selected-primary").at(-1);
  assert.equal(primary.config.account_id, "selected-account");
  assert.equal(primary.config.d1_databases[0].database_id, "selected-db");
  assert.equal(primary.config.vars.DEPLOYMENT_ID, "selected-installation");
  assert.equal(primary.config.vars.REALTIME_RELEASES, "seamless");
  const companion = completed.calls.find(call =>
    call.args[0] === "deploy" && call.config.name.startsWith("agw-rt-"));
  assert.equal(companion.ciName, undefined);
  assert.equal(companion.config.services[0].service, "selected-primary");
  assert.equal(primary.ciName, "selected-primary");
  // A legacy Worker with no identity stops before secret/deployment mutations.
  completed.workers["selected-primary"].bindings = [];
  completed.calls = [];
  writeFileSync(statePath, JSON.stringify(completed));
  const legacy = run();
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /Cannot verify.*without DEPLOYMENT_ID/);
  assert.ok(JSON.parse(readFileSync(statePath)).calls.every(call =>
    call.args.includes("--dry-run") || ["auth", "deployments", "versions"].includes(call.args[0])));
});

test("a deploy checks the gateway where it answers, custom domain included", async () => {
  const { gatewayOrigin } = await import("../scripts/seamless-root.mjs");
  const domain = { pattern: "console.example.com", custom_domain: true };
  // The custom-domain guide's setup: no workers.dev, one custom domain, no URL vars.
  assert.equal(gatewayOrigin({ workers_dev: false, routes: [domain] }, "gw", "acct"), "https://console.example.com");
  assert.equal(
    gatewayOrigin({ workers_dev: false, routes: [domain], vars: { PUBLIC_API_URL: "https://api.example.com" } }, "gw", "acct"),
    "https://api.example.com",
  );
  assert.equal(gatewayOrigin({}, "gw", "acct"), "https://gw.acct.workers.dev");
  // Nothing reaches it: the version check is skipped, not run against workers.dev.
  assert.equal(gatewayOrigin({ workers_dev: false }, "gw", "acct"), undefined);
  assert.equal(gatewayOrigin({}, "gw", undefined), undefined);
});

test("a prebuilt deploy releases the built gateway and realtime Worker without bundling anything", t => {
  const { directory, statePath, run } = checkoutFixture(t);
  // As scripts/build-prebuilt.mjs lays it out, in a job with no secrets.
  for (const folder of ["worker", "realtime", "console"]) mkdirSync(join(directory, "built", folder), { recursive: true });
  writeFileSync(join(directory, "built/worker/index.js"), "export default { gateway: true };\n");
  writeFileSync(join(directory, "built/realtime/worker.js"), "export default { realtime: true };\n");
  writeFileSync(join(directory, "built/console/index.html"), "<!doctype html>\n");

  run("--prebuilt", "built"); // stops after creating the secrets, as on any first install
  const result = run("--prebuilt", "built");
  assert.equal(result.status, 0, result.stderr);

  const { calls } = JSON.parse(readFileSync(statePath));
  // The deploy job has only Wrangler: nothing is bundled there.
  assert.equal(calls.filter(call => call.args.includes("--dry-run")).length, 0);
  const deploys = calls.filter(call => call.args[0] === "deploy");
  const primary = deploys.filter(call => call.config.name === "selected-primary").at(-1);
  assert.match(primary.config.main, /built[/\\]worker[/\\]index\.js$/u);
  assert.equal(primary.config.no_bundle, true);
  assert.match(primary.config.assets.directory, /built[/\\]console$/u);
  const realtime = deploys.find(call => call.config.name.startsWith("agw-rt-"));
  assert.match(realtime.config.main, /built[/\\]realtime[/\\]worker\.js$/u);
  assert.equal(realtime.config.no_bundle, true);

  // A later deploy of the same realtime Worker reuses it: no new one, so
  // the sessions open on it stay open.
  const before = deploys.filter(call => call.config.name.startsWith("agw-rt-")).length;
  writeFileSync(join(directory, "built/worker/index.js"), "export default { gateway: 2 };\n");
  const again = run("--prebuilt", "built");
  assert.equal(again.status, 0, again.stderr);
  const after = JSON.parse(readFileSync(statePath)).calls
    .filter(call => call.args[0] === "deploy" && call.config.name.startsWith("agw-rt-")).length;
  assert.equal(after, before);
  assert.match(again.stdout, /Reusing immutable realtime release/u);
});
